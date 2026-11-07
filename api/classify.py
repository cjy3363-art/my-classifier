"""MEDI TASK — Gemini 업무 분류 서버 함수 (Vercel Python, 표준 라이브러리만 사용)

POST /api/classify
  요청: {"texts": ["마스킹된 문장", ...], "model": "gemini-..."}   (1~10개, 각 500자 이하, model은 선택)
        model을 보내면 api/models.py의 허용·지원 모델 목록으로 검증한다. 없으면 GEMINI_MODEL/기본 모델.
  응답: {"model": "...", "results": [{"category": "...", "urgency": "...", "reason": "..."}, ...]}
  오류: {"error": {"code": "...", "message": "..."}}  (원문·API 키는 절대 포함하지 않음)

환경 변수
  GEMINI_API_KEY  (필수)  Google AI Studio API 키. 코드·브라우저·Git에 넣지 않는다.
  GEMINI_MODEL    (선택)  기본값 gemini-3.5-flash-lite

개인정보 보호
  - 브라우저(mask.js)에서 가린 문장만 받는다.
  - 마스킹 누락에 대비해 서버에서도 전화번호·이메일·사번 형식을 한 번 더 가린 뒤 Gemini로 보낸다.
  - 요청·응답 본문을 로그로 남기지 않는다 (print/logging 사용 안 함).

분류 기준은 criteria.json만 사용한다. 사람 정답(answer.json)이나 예시 문장은 지시문에 넣지 않는다.
"""

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import models as gm  # noqa: E402  (같은 폴더의 api/models.py: 모델 목록·검증·호출 제한)

DEFAULT_MODEL = gm.DEFAULT_MODEL
DEFAULT_MAX_OUTPUT_TOKENS = 4096
CLASSIFY_LIMITER = gm.RateLimiter(limit=20, window_seconds=60)  # IP별, 인스턴스별 (최선의 노력)
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT_SECONDS = 60
MAX_TEXTS = 10
MAX_TEXT_LEN = 500
MAX_BODY_BYTES = 64 * 1024
MAX_REASON_LEN = 200
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{1,63}$")

# 서버 측 2차 마스킹 (브라우저 마스킹 누락 대비, 이름은 형식이 없어 브라우저에서만 처리)
SERVER_MASKS = [
    (re.compile(r"01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}"), "[전화번호]"),
    (re.compile(r"(?:0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}|1[5-9]\d{2}[-.\s]\d{4})"), "[전화번호]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[이메일]"),
    (re.compile(r"((?:사번|사원\s?번호|직원\s?번호)\s*[:：]?\s*)[A-Za-z]{0,4}-?\d{3,12}", re.I), r"\1[사번]"),
]


ApiError = gm.ApiError  # 두 서버 함수가 같은 오류 형식을 쓴다


# ---------------- 기준 ----------------
def load_criteria():
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, "..", "criteria.json"), os.path.join(os.getcwd(), "criteria.json")):
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    raise ApiError(500, "criteria_unavailable", "분류 기준을 불러오지 못했습니다.")


def allowed_values(criteria):
    cats = [c["name"] for c in criteria.get("categories", [])]
    levels = [l["name"] for l in criteria.get("urgency", {}).get("levels", [])]
    if not cats or not levels:
        raise ApiError(500, "criteria_invalid", "분류 기준 형식이 올바르지 않습니다.")
    return cats, levels


def build_prompt(criteria, texts):
    """criteria.json의 정의·규칙·판단 순서만으로 지시문을 만든다 (예시 문장·정답 미포함)."""
    cats, levels = allowed_values(criteria)
    lines = [
        "너는 병의원 마케팅팀의 업무 요청 분류기다. 아래 기준만 사용해 각 요청의 업무 유형과 긴급도를 정한다.",
        "",
        "[업무 유형]",
    ]
    for c in criteria["categories"]:
        lines.append(f"- {c['name']}: {c.get('definition', '')}")
        if c.get("keywords"):
            lines.append(f"  판단 키워드: {', '.join(c['keywords'])}")
        for inc in c.get("includes", []):
            lines.append(f"  포함: {inc}")
        if c.get("exception"):
            lines.append(f"  예외: {c['exception']}")
    prio = criteria.get("category_priority", {})
    lines += ["", "[중복 분류]", prio.get("rule", ""), "우선순위: " + " → ".join(prio.get("order", [])), prio.get("core_task_principle", "")]
    urg = criteria.get("urgency", {})
    lines += ["", "[긴급도 단계]"]
    for l in urg.get("levels", []):
        lines.append(f"- {l['name']}: " + " / ".join(l.get("criteria", [])))
    steps = urg.get("decision_steps", {})
    lines += ["", "[긴급도 판단 순서] " + steps.get("rule", "")]
    for s in steps.get("steps", []):
        lines.append(f"{s['step']}. {s['check']} → {s['if_yes']}" + (f" ({s['note']})" if s.get("note") else ""))
    lines += ["", "[긴급도 판단 규칙]"] + [f"- {r}" for r in urg.get("rules", [])]
    ud = urg.get("unclear_deadline", {})
    if ud.get("rule"):
        lines.append(f"- {ud['rule']}")  # future_recommendation은 현재 미적용이라 넣지 않는다
    scope = criteria.get("current_version_scope", {})
    if scope.get("note"):
        lines.append(f"- {scope['note']}")
    lines += [
        "",
        "[출력 형식]",
        "JSON 객체 하나만 출력한다. 설명 문장이나 코드 블록 표시는 쓰지 않는다.",
        '{"results": [{"index": 1, "category": "...", "urgency": "...", "reason": "..."}]}',
        f"- results의 개수는 요청 개수({len(texts)})와 같아야 하고, index는 1부터 요청 순서대로 쓴다.",
        f"- category는 다음 중 하나: {', '.join(cats)}",
        f"- urgency는 다음 중 하나: {', '.join(levels)}",
        "- reason은 판단 근거를 한국어 한 문장으로 쓴다.",
        "- [이름], [전화번호], [사번], [이메일]은 가려진 개인정보이며 추측하지 않는다.",
        "",
        "[요청]",
    ]
    for i, t in enumerate(texts, 1):
        lines.append(f"{i}. {t}")
    return "\n".join(lines)


# ---------------- 입력 ----------------
def server_mask(text):
    out = text
    for pattern, repl in SERVER_MASKS:
        out = pattern.sub(repl, out)
    return out


def validate_texts(payload):
    if not isinstance(payload, dict) or "texts" not in payload:
        raise ApiError(400, "bad_request", "texts 배열이 필요합니다.")
    texts = payload["texts"]
    if not isinstance(texts, list) or not (1 <= len(texts) <= MAX_TEXTS):
        raise ApiError(400, "bad_request", f"texts는 1~{MAX_TEXTS}개여야 합니다.")
    clean = []
    for t in texts:
        if not isinstance(t, str) or not t.strip():
            raise ApiError(400, "bad_request", "빈 문장이 있습니다.")
        if len(t) > MAX_TEXT_LEN:
            raise ApiError(400, "bad_request", f"문장은 {MAX_TEXT_LEN}자 이하여야 합니다.")
        clean.append(server_mask(t.strip()))
    return clean


# ---------------- Gemini 호출 ----------------
def get_model():
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    if not MODEL_RE.match(model):
        raise ApiError(500, "model_invalid", "GEMINI_MODEL 값이 올바르지 않습니다.")
    return model


def resolve_model(payload, api_key, urlopen=None):
    """요청한 모델을 검증한다. 반환: (model_id, 최대 출력 토큰)

    - model을 보내지 않으면 기존처럼 GEMINI_MODEL 또는 기본 모델 (STEP 5 호환)
    - model을 보내면: 형식·허용 계열·허용 목록(GEMINI_ALLOWED_MODELS)을 검사하고,
      서버가 조회한 실제 지원 모델(models.list, generateContent 지원) 목록에 있어야 한다.
    """
    requested = payload.get("model") if isinstance(payload, dict) else None
    if requested is None:
        return get_model(), DEFAULT_MAX_OUTPUT_TOKENS
    if not gm.is_allowed_id(requested):
        raise ApiError(400, "model_not_allowed", "허용되지 않은 모델입니다.")
    available, _, _ = gm.list_models(api_key, urlopen)
    entry = next((m for m in available if m["id"] == requested), None)
    if entry is None:
        raise ApiError(400, "model_not_allowed", "지원되지 않는 모델입니다.")
    limit = entry.get("outputTokenLimit")
    return requested, min(DEFAULT_MAX_OUTPUT_TOKENS, limit) if isinstance(limit, int) and limit > 0 else DEFAULT_MAX_OUTPUT_TOKENS


def call_gemini(prompt, model, api_key, use_json_mode=True, urlopen=None, max_tokens=DEFAULT_MAX_OUTPUT_TOKENS):
    urlopen = urlopen or urllib.request.urlopen
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    if use_json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json", "maxOutputTokens": max_tokens}
    req = urllib.request.Request(
        API_URL.format(model=model),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        status = e.code
        if status == 400 and use_json_mode:
            raise ApiError(400, "upstream_bad_request", "AI 요청 형식 오류")
        if status in (401, 403):
            raise ApiError(502, "upstream_auth", "AI 서비스 인증에 실패했습니다.")
        if status == 404:
            raise ApiError(502, "upstream_model", "AI 모델을 찾지 못했습니다.")
        if status == 429:
            raise ApiError(429, "rate_limited", "AI 호출 한도를 초과했습니다.")
        raise ApiError(502, "upstream_error", f"AI 서비스 오류 ({status})")
    except (socket.timeout, TimeoutError):
        raise ApiError(504, "timeout", "AI 응답 시간이 초과되었습니다.")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
            raise ApiError(504, "timeout", "AI 응답 시간이 초과되었습니다.")
        raise ApiError(502, "upstream_unreachable", "AI 서비스에 연결하지 못했습니다.")
    except (ValueError, UnicodeDecodeError):
        raise ApiError(502, "invalid_response", "AI 응답을 해석하지 못했습니다.")


def extract_text(data):
    if not isinstance(data, dict):
        raise ApiError(502, "invalid_response", "AI 응답 형식이 올바르지 않습니다.")
    if (data.get("promptFeedback") or {}).get("blockReason"):
        raise ApiError(502, "blocked", "AI가 요청 처리를 거부했습니다.")
    cands = data.get("candidates") or []
    if not cands:
        raise ApiError(502, "invalid_response", "AI 응답이 비어 있습니다.")
    cand = cands[0]
    if cand.get("finishReason") not in (None, "STOP"):
        raise ApiError(502, "incomplete", "AI 응답이 완료되지 않았습니다.")
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    if not text.strip():
        raise ApiError(502, "invalid_response", "AI 응답이 비어 있습니다.")
    return text


def parse_results(text, n, cats, levels):
    """AI 출력 JSON을 엄격하게 검증한다. 하나라도 어긋나면 전체를 실패로 본다."""
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", s).strip()
    try:
        obj = json.loads(s)
    except ValueError:
        raise ApiError(502, "invalid_json", "AI 응답이 JSON 형식이 아닙니다.")
    results = obj.get("results") if isinstance(obj, dict) else obj
    if not isinstance(results, list) or len(results) != n:
        raise ApiError(502, "count_mismatch", "AI 응답 개수가 요청 개수와 다릅니다.")
    out = []
    for i, r in enumerate(results, 1):
        if not isinstance(r, dict):
            raise ApiError(502, "invalid_item", "AI 응답 항목 형식이 올바르지 않습니다.")
        if "index" in r and r["index"] != i:
            raise ApiError(502, "order_mismatch", "AI 응답 순서가 요청 순서와 다릅니다.")
        cat, urg, reason = r.get("category"), r.get("urgency"), r.get("reason")
        if cat not in cats or urg not in levels:
            raise ApiError(502, "invalid_value", "AI가 허용되지 않은 분류값을 반환했습니다.")
        if not isinstance(reason, str) or not reason.strip():
            raise ApiError(502, "invalid_item", "AI 응답에 판단 이유가 없습니다.")
        reason = " ".join(reason.split())[:MAX_REASON_LEN]
        out.append({"category": cat, "urgency": urg, "reason": reason})
    return out


def classify(payload, env_key=None, urlopen=None):
    texts = validate_texts(payload)
    # 모델 ID 형식·허용 계열은 키 설정과 관계없이 먼저 거른다 (실제 지원 여부는 resolve_model에서 목록과 대조)
    if isinstance(payload, dict) and payload.get("model") is not None and not gm.is_allowed_id(payload.get("model")):
        raise ApiError(400, "model_not_allowed", "허용되지 않은 모델입니다.")
    api_key = env_key if env_key is not None else os.environ.get("GEMINI_API_KEY", "")
    if not api_key.strip():
        raise ApiError(503, "not_configured", "AI 분류가 설정되지 않았습니다.")
    model, max_tokens = resolve_model(payload, api_key.strip(), urlopen)
    criteria = load_criteria()
    cats, levels = allowed_values(criteria)
    prompt = build_prompt(criteria, texts)
    try:
        data = call_gemini(prompt, model, api_key.strip(), True, urlopen, max_tokens)
    except ApiError as e:
        if e.code != "upstream_bad_request":
            raise
        # JSON 모드 필드를 지원하지 않는 모델이면 한 번만 일반 모드로 다시 요청
        data = call_gemini(prompt, model, api_key.strip(), False, urlopen, max_tokens)
    results = parse_results(extract_text(data), len(texts), cats, levels)
    return {"model": model, "results": results}


# ---------------- HTTP ----------------
class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, code, message):
        self._send(status, {"error": {"code": code, "message": message}})

    def do_POST(self):
        try:
            if not CLASSIFY_LIMITER.allow(gm.client_id(self)):
                raise ApiError(429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.")
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ApiError(400 if length <= 0 else 413, "bad_request", "요청 본문 크기가 올바르지 않습니다.")
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "bad_request", "요청 본문이 JSON이 아닙니다.")
            self._send(200, classify(payload))
        except ApiError as e:
            self._error(e.status, e.code, e.message)
        except Exception:  # 내부 예외 내용(원문 포함 가능)은 응답·로그에 내보내지 않는다
            self._error(500, "internal_error", "서버 내부 오류가 발생했습니다.")

    def do_GET(self):
        self._error(405, "method_not_allowed", "POST만 지원합니다.")

    def log_message(self, format, *args):  # 기본 접근 로그 끄기 (요청 경로 외 정보도 남기지 않음)
        return
