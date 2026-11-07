"""api/models.py 단위 테스트 + classify의 모델 선택 검증 (모의 테스트: 실제 Gemini를 호출하지 않는다)

실행: py -m unittest discover -s tests -v
"""
import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import models as M  # noqa: E402
import classify as C  # noqa: E402

REAL_URLOPEN = urllib.request.urlopen
FAKE_KEY = "TEST-KEY-never-in-output-9876543210"

# models.list 모의 응답 (실제 응답 필드 이름: name, displayName, supportedGenerationMethods, outputTokenLimit ...)
RAW_MODELS = [
    {"name": "models/gemini-2.5-flash-lite", "displayName": "Gemini 2.5 Flash-Lite", "supportedGenerationMethods": ["generateContent", "countTokens"], "outputTokenLimit": 65536},
    {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "supportedGenerationMethods": ["generateContent"], "outputTokenLimit": 2048},
    {"name": "models/gemini-3.5-flash-lite", "displayName": "Gemini 3.5 Flash-Lite", "supportedGenerationMethods": ["generateContent"], "thinking": True},
    {"name": "models/gemini-3.1-pro-preview", "displayName": "Gemini 3.1 Pro Preview", "supportedGenerationMethods": ["generateContent"]},
    {"name": "models/gemini-2.5-flash-image", "displayName": "Image", "supportedGenerationMethods": ["generateContent"]},
    {"name": "models/gemini-2.5-flash-preview-tts", "displayName": "TTS", "supportedGenerationMethods": ["generateContent"]},
    {"name": "models/gemini-embedding-001", "displayName": "Embedding", "supportedGenerationMethods": ["embedContent"]},
    {"name": "models/gemini-3.6-flash", "displayName": "Gemini 3.6 Flash", "supportedGenerationMethods": ["countTokens"]},
    {"name": "models/gemma-3-27b-it", "displayName": "Gemma", "supportedGenerationMethods": ["generateContent"]},
    {"name": "tunedModels/x", "supportedGenerationMethods": ["generateContent"]},
]


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def router(list_pages, gen_payload=None, log=None):
    """URL로 models.list와 generateContent를 구분해 모의 응답"""
    state = {"page": 0}

    def _open(req, timeout=None):
        if log is not None:
            log.append({"url": req.full_url, "method": req.get_method(), "headers": dict(req.header_items()), "body": json.loads(req.data.decode("utf-8")) if req.data else None})
        if "/models?pageSize" in req.full_url:
            p = list_pages[min(state["page"], len(list_pages) - 1)]
            state["page"] += 1
            return FakeResp(json.dumps(p).encode("utf-8"))
        return FakeResp(json.dumps(gen_payload).encode("utf-8"))
    return _open


def gen_ok(n):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps({"results": [{"index": i + 1, "category": "기타", "urgency": "보통", "reason": "모의"} for i in range(n)]}, ensure_ascii=False)}]}, "finishReason": "STOP"}]}


class FilterTests(unittest.TestCase):
    def setUp(self):
        M.clear_cache()

    def test_filter_keeps_only_text_generate_content_gemini(self):
        ids = [m["id"] for m in M.filter_models(RAW_MODELS)]
        self.assertEqual(set(ids), {"gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"})
        for bad in ["gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-embedding-001", "gemini-3.6-flash", "gemma-3-27b-it"]:
            self.assertNotIn(bad, ids)

    def test_stage_only_from_official_id_marking(self):
        by = {m["id"]: m for m in M.filter_models(RAW_MODELS)}
        self.assertEqual(by["gemini-3.1-pro-preview"]["stage"], "preview")
        self.assertIsNone(by["gemini-2.5-pro"]["stage"])  # 'stable'로 단정하지 않음

    def test_sort_newest_first_preview_after(self):
        ids = [m["id"] for m in M.filter_models(RAW_MODELS)]
        self.assertEqual(ids[0], "gemini-3.5-flash-lite")
        self.assertLess(ids.index("gemini-3.5-flash-lite"), ids.index("gemini-2.5-flash-lite"))

    def test_is_allowed_id_rejects_injection(self):
        for bad in ["../x", "gemini-2.5-flash?key=1", "gemini-2.5-flash/../../x", "GEMINI-2.5-FLASH", "gemini-2.5-flash-image", "gpt-4", "", None, 1, "gemini-2.5-flash%2F"]:
            self.assertFalse(M.is_allowed_id(bad), bad)
        self.assertTrue(M.is_allowed_id("gemini-2.5-flash"))

    def test_env_allowlist_restricts(self):
        with mock.patch.dict(os.environ, {"GEMINI_ALLOWED_MODELS": "gemini-2.5-flash-lite"}):
            self.assertEqual([m["id"] for m in M.filter_models(RAW_MODELS)], ["gemini-2.5-flash-lite"])
            self.assertFalse(M.is_allowed_id("gemini-2.5-pro"))


class ListTests(unittest.TestCase):
    def setUp(self):
        M.clear_cache()

    def test_pagination_and_header_key(self):
        log = []
        pages = [{"models": RAW_MODELS[:3], "nextPageToken": "abc"}, {"models": RAW_MODELS[3:]}]
        models, cached, _ = M.list_models(FAKE_KEY, router(pages, log=log))
        self.assertFalse(cached)
        self.assertEqual(len(log), 2)
        self.assertIn("pageToken=abc", log[1]["url"])
        self.assertEqual(log[0]["headers"].get("X-goog-api-key"), FAKE_KEY)
        self.assertNotIn(FAKE_KEY, log[0]["url"])  # 키는 URL에 넣지 않음
        self.assertEqual(len(models), 4)

    def test_cache_10_minutes(self):
        log = []
        t = [1000.0]
        M.list_models(FAKE_KEY, router([{"models": RAW_MODELS}], log=log), now=lambda: t[0])
        t[0] += 599
        _, cached, _ = M.list_models(FAKE_KEY, router([{"models": RAW_MODELS}], log=log), now=lambda: t[0])
        self.assertTrue(cached)
        t[0] += 2
        _, cached, _ = M.list_models(FAKE_KEY, router([{"models": RAW_MODELS}], log=log), now=lambda: t[0])
        self.assertFalse(cached)
        self.assertEqual(len(log), 2)

    def test_errors(self):
        with self.assertRaises(M.ApiError) as cm:
            M.list_models("")
        self.assertEqual(cm.exception.code, "not_configured")

        def raiser(status):
            def _o(req, timeout=None):
                raise urllib.error.HTTPError("u", status, "x", {}, None)
            return _o
        for status, code in [(403, "upstream_auth"), (429, "rate_limited"), (500, "upstream_error")]:
            M.clear_cache()
            with self.assertRaises(M.ApiError) as cm:
                M.list_models(FAKE_KEY, raiser(status))
            self.assertEqual(cm.exception.code, code)
            self.assertNotIn(FAKE_KEY, cm.exception.message)
        M.clear_cache()
        with self.assertRaises(M.ApiError) as cm:
            M.list_models(FAKE_KEY, router([{"models": RAW_MODELS[4:]}]))  # 허용 모델이 하나도 없음
        self.assertEqual(cm.exception.code, "no_models")

    def test_default_model(self):
        models = M.filter_models(RAW_MODELS)
        self.assertEqual(M.default_model_id(models), "gemini-3.5-flash-lite")
        with mock.patch.dict(os.environ, {"GEMINI_MODEL": "gemini-2.5-pro"}):
            self.assertEqual(M.default_model_id(models), "gemini-2.5-pro")
        with mock.patch.dict(os.environ, {"GEMINI_MODEL": "does-not-exist"}):
            self.assertEqual(M.default_model_id(models), "gemini-3.5-flash-lite")


class RateLimitTests(unittest.TestCase):
    def test_sliding_window(self):
        rl = M.RateLimiter(3, 60)
        self.assertEqual([rl.allow("ip", now=t) for t in (0, 1, 2, 3)], [True, True, True, False])
        self.assertTrue(rl.allow("other", now=3))
        self.assertTrue(rl.allow("ip", now=61))


class ClassifyModelSelectionTests(unittest.TestCase):
    def setUp(self):
        M.clear_cache()

    def test_selected_model_is_used_and_token_limit_applied(self):
        log = []
        out = C.classify({"texts": ["a"], "model": "gemini-2.5-pro"}, env_key=FAKE_KEY, urlopen=router([{"models": RAW_MODELS}], gen_ok(1), log))
        self.assertEqual(out["model"], "gemini-2.5-pro")
        gen = [x for x in log if ":generateContent" in x["url"]][0]
        self.assertTrue(gen["url"].endswith("/models/gemini-2.5-pro:generateContent"))
        self.assertEqual(gen["body"]["generationConfig"]["maxOutputTokens"], 2048)  # 모델 출력 한도가 더 작으면 그 값

    def test_rejected_models_never_reach_gemini(self):
        for bad, why in [("gemini-2.5-flash-image", "제외 계열"), ("../../v1/x", "경로 문자"), ("gemini-9.9-flash", "목록에 없음"), ("gemini-3.6-flash", "generateContent 미지원")]:
            with self.subTest(why=why):
                M.clear_cache()
                log = []
                with self.assertRaises(C.ApiError) as cm:
                    C.classify({"texts": ["a"], "model": bad}, env_key=FAKE_KEY, urlopen=router([{"models": RAW_MODELS}], gen_ok(1), log))
                self.assertEqual((cm.exception.status, cm.exception.code), (400, "model_not_allowed"))
                self.assertFalse(any(":generateContent" in x["url"] for x in log))

    def test_bad_model_rejected_even_without_key(self):
        with self.assertRaises(C.ApiError) as cm:
            C.classify({"texts": ["a"], "model": "../x"}, env_key="")
        self.assertEqual((cm.exception.status, cm.exception.code), (400, "model_not_allowed"))

    def test_allowlist_blocks_expensive_model(self):
        with mock.patch.dict(os.environ, {"GEMINI_ALLOWED_MODELS": "gemini-3.5-flash-lite"}):
            with self.assertRaises(C.ApiError) as cm:
                C.classify({"texts": ["a"], "model": "gemini-2.5-pro"}, env_key=FAKE_KEY, urlopen=router([{"models": RAW_MODELS}], gen_ok(1)))
            self.assertEqual(cm.exception.code, "model_not_allowed")

    def test_model_list_failure_blocks_selected_model(self):
        def fail(req, timeout=None):
            raise urllib.error.HTTPError("u", 500, "x", {}, None)
        with self.assertRaises(C.ApiError) as cm:
            C.classify({"texts": ["a"], "model": "gemini-2.5-pro"}, env_key=FAKE_KEY, urlopen=fail)
        self.assertEqual(cm.exception.code, "upstream_error")

    def test_no_model_param_keeps_step5_behavior(self):
        log = []
        out = C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=router([{"models": RAW_MODELS}], gen_ok(1), log))
        self.assertEqual(out["model"], C.DEFAULT_MODEL)
        self.assertFalse(any("/models?pageSize" in x["url"] for x in log))  # 목록 조회 없이 기존 방식


class ModelsHandlerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), M.handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        M.clear_cache()
        M.LIST_LIMITER.hits.clear()

    def get(self):
        try:
            with REAL_URLOPEN(f"http://127.0.0.1:{self.port}/api/models", timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_no_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            status, body = self.get()
        self.assertEqual((status, body["error"]["code"]), (503, "not_configured"))

    def test_success_shape_without_key_leak(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": FAKE_KEY}), mock.patch.object(M.urllib.request, "urlopen", router([{"models": RAW_MODELS}])):
            status, body = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(body["default"], "gemini-3.5-flash-lite")
        self.assertEqual({m["id"] for m in body["models"]}, {"gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"})
        self.assertNotIn(FAKE_KEY, json.dumps(body))
        self.assertIn("stage_note", body)

    def test_rate_limit(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            codes = [self.get()[0] for _ in range(31)]
        self.assertEqual(codes[-1], 429)


if __name__ == "__main__":
    unittest.main()
