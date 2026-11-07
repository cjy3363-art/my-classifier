"""MEDI TASK — Gemini 모델 목록 서버 함수 (Vercel Python, 표준 라이브러리만 사용)

GET /api/models
  응답: {"models": [{"id", "displayName", "stage", "inputTokenLimit", "outputTokenLimit", "thinking"}],
         "default": "...", "cached": bool, "fetched_at": "...", "stage_note": "..."}
  오류: {"error": {"code": "...", "message": "..."}}

근거: Gemini API models.list (GET https://generativelanguage.googleapis.com/v1beta/models)
  - 응답 models[]의 name 형식은 "models/{model}", supportedGenerationMethods에 "generateContent"가 있어야 분류에 쓸 수 있다.
  - Model 리소스에는 Stable/Preview·지원 종료를 나타내는 필드가 없다. 그래서 공식 모델 ID의 "preview"/"exp" 표기로만
    Preview를 구분하고, 그 밖의 모델은 stage를 null(구분 정보 없음)로 둔다.

이 모듈은 api/classify.py에서도 모델 검증·호출 제한에 함께 쓴다.
"""

import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
TIMEOUT_SECONDS = 20
CACHE_TTL_SECONDS = 600
MAX_PAGES = 5
DEFAULT_MODEL = "gemini-3.5-flash-lite"

# 모델 ID 형식: 경로·쿼리 문자가 들어갈 수 없게 소문자·숫자·점·하이픈만
MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{1,63}$")
# 허용 계열: gemini-{버전}-{pro|flash|flash-lite}[-접미사]  (예: gemini-2.5-flash, gemini-3.1-pro-preview)
FAMILY_RE = re.compile(r"^gemini-\d+(?:\.\d+)?-(?:pro|flash|flash-lite)(?:-[a-z0-9.\-]+)?$")
# 텍스트 분류에 맞지 않는 모델 (이미지·음성·임베딩·실시간·특수 목적)
EXCLUDE_RE = re.compile(r"(image|tts|audio|live|embed|veo|imagen|aqa|native|computer-use|robotics|vision|deep-research|lyria|transcri|banana)")
PREVIEW_RE = re.compile(r"(preview|exp)")


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


# ---------------- 허용 모델 판정 ----------------
def env_allowlist():
    """GEMINI_ALLOWED_MODELS(쉼표 구분)를 설정하면 그 모델만 허용한다 (고비용 모델 차단용)."""
    raw = os.environ.get("GEMINI_ALLOWED_MODELS", "")
    ids = {x.strip() for x in raw.split(",") if x.strip()}
    return ids or None


def is_allowed_id(model_id):
    if not isinstance(model_id, str) or not MODEL_ID_RE.match(model_id):
        return False
    if not FAMILY_RE.match(model_id) or EXCLUDE_RE.search(model_id):
        return False
    allow = env_allowlist()
    return allow is None or model_id in allow


def to_entry(m):
    name = m.get("name", "") if isinstance(m, dict) else ""
    if not name.startswith("models/"):
        return None
    mid = name[len("models/"):]
    if "generateContent" not in (m.get("supportedGenerationMethods") or []):
        return None
    if not is_allowed_id(mid):
        return None
    return {
        "id": mid,
        "displayName": str(m.get("displayName") or mid)[:80],
        "stage": "preview" if PREVIEW_RE.search(mid) else None,
        "inputTokenLimit": m.get("inputTokenLimit") if isinstance(m.get("inputTokenLimit"), int) else None,
        "outputTokenLimit": m.get("outputTokenLimit") if isinstance(m.get("outputTokenLimit"), int) else None,
        "thinking": m.get("thinking") if isinstance(m.get("thinking"), bool) else None,
    }


def sort_key(e):
    m = re.match(r"^gemini-(\d+)(?:\.(\d+))?-(pro|flash-lite|flash)", e["id"])
    major, minor, tier = (int(m.group(1)), int(m.group(2) or 0), m.group(3)) if m else (0, 0, "")
    tier_rank = {"flash-lite": 0, "flash": 1, "pro": 2}.get(tier, 3)
    return (-major, -minor, e["stage"] == "preview", tier_rank, e["id"])


def filter_models(raw_models):
    seen, out = set(), []
    for m in raw_models:
        e = to_entry(m)
        if e and e["id"] not in seen:
            seen.add(e["id"])
            out.append(e)
    return sorted(out, key=sort_key)


# ---------------- 조회 + 캐시 ----------------
_cache = {"at": 0.0, "models": None, "fetched_at": None}
_cache_lock = threading.Lock()


def map_http_error(status):
    if status in (401, 403):
        return ApiError(502, "upstream_auth", "AI 서비스 인증에 실패했습니다.")
    if status == 429:
        return ApiError(429, "rate_limited", "AI 호출 한도를 초과했습니다.")
    return ApiError(502, "upstream_error", f"AI 서비스 오류 ({status})")


def fetch_all(api_key, urlopen=None):
    urlopen = urlopen or urllib.request.urlopen
    models, token = [], None
    for _ in range(MAX_PAGES):
        url = LIST_URL + (f"&pageToken={urllib.parse.quote(token)}" if token else "")
        req = urllib.request.Request(url, headers={"x-goog-api-key": api_key}, method="GET")
        try:
            with urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise map_http_error(e.code)
        except (socket.timeout, TimeoutError):
            raise ApiError(504, "timeout", "모델 목록 응답 시간이 초과되었습니다.")
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
                raise ApiError(504, "timeout", "모델 목록 응답 시간이 초과되었습니다.")
            raise ApiError(502, "upstream_unreachable", "AI 서비스에 연결하지 못했습니다.")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(502, "invalid_response", "모델 목록을 해석하지 못했습니다.")
        if not isinstance(data, dict):
            raise ApiError(502, "invalid_response", "모델 목록 형식이 올바르지 않습니다.")
        models.extend(data.get("models") or [])
        token = data.get("nextPageToken")
        if not token:
            break
    return models


def list_models(api_key=None, urlopen=None, force=False, now=time.time):
    """허용·지원 모델 목록. 같은 서버 인스턴스에서는 10분간 캐시한다. 반환: (models, cached, fetched_at)"""
    key = (api_key if api_key is not None else os.environ.get("GEMINI_API_KEY", "")).strip()
    if not key:
        raise ApiError(503, "not_configured", "AI 분류가 설정되지 않았습니다.")
    with _cache_lock:
        if not force and _cache["models"] is not None and now() - _cache["at"] < CACHE_TTL_SECONDS:
            return _cache["models"], True, _cache["fetched_at"]
    models = filter_models(fetch_all(key, urlopen))
    if not models:
        raise ApiError(502, "no_models", "사용할 수 있는 Gemini 모델이 없습니다.")
    fetched_at = datetime.now(timezone.utc).isoformat()
    with _cache_lock:
        _cache.update(at=now(), models=models, fetched_at=fetched_at)
    return models, False, fetched_at


def clear_cache():
    with _cache_lock:
        _cache.update(at=0.0, models=None, fetched_at=None)


def default_model_id(models):
    env = (os.environ.get("GEMINI_MODEL") or "").strip()
    ids = [m["id"] for m in models]
    for cand in (env, DEFAULT_MODEL):
        if cand and cand in ids:
            return cand
    non_preview = [m["id"] for m in models if m["stage"] != "preview"]
    return (non_preview or ids)[0]


# ---------------- 호출 제한 (서버 인스턴스별, 최선의 노력) ----------------
class RateLimiter:
    """IP별 슬라이딩 윈도. 서버리스 인스턴스마다 메모리가 따로라 전체 한도를 보장하지는 못한다."""

    def __init__(self, limit, window_seconds):
        self.limit, self.window = limit, window_seconds
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, client, now=None):
        now = time.time() if now is None else now
        with self.lock:
            q = [t for t in self.hits.get(client, []) if now - t < self.window]
            if len(q) >= self.limit:
                self.hits[client] = q
                return False
            q.append(now)
            self.hits[client] = q
            if len(self.hits) > 5000:  # 메모리 보호
                self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < self.window}
            return True


def client_id(handler_obj):
    fwd = (handler_obj.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return fwd or (handler_obj.headers.get("x-real-ip") or "").strip() or (handler_obj.client_address[0] if handler_obj.client_address else "unknown")


LIST_LIMITER = RateLimiter(limit=30, window_seconds=60)


def send_json(h, status, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Cache-Control", "no-store")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            if not LIST_LIMITER.allow(client_id(self)):
                raise ApiError(429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.")
            models, cached, fetched_at = list_models()
            send_json(self, 200, {
                "models": models, "default": default_model_id(models), "cached": cached, "fetched_at": fetched_at,
                "stage_note": "Gemini API 모델 정보에는 Stable/Preview 필드가 없어 모델 ID의 preview·exp 표기로만 Preview를 구분합니다.",
            })
        except ApiError as e:
            send_json(self, e.status, {"error": {"code": e.code, "message": e.message}})
        except Exception:
            send_json(self, 500, {"error": {"code": "internal_error", "message": "서버 내부 오류가 발생했습니다."}})

    def do_POST(self):
        send_json(self, 405, {"error": {"code": "method_not_allowed", "message": "GET만 지원합니다."}})

    def log_message(self, format, *args):
        return
