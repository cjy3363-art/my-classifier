"""api/classify.py 단위 테스트 (모의 테스트: 실제 Gemini를 호출하지 않는다)

실행: py -m unittest discover -s tests -v
"""
import io
import json
import os
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import classify as C  # noqa: E402

with open(os.path.join(ROOT, "criteria.json"), encoding="utf-8") as _f:
    CRITERIA = json.load(_f)
CATS = [c["name"] for c in CRITERIA["categories"]]
LEVELS = [l["name"] for l in CRITERIA["urgency"]["levels"]]
FAKE_KEY = "TEST-KEY-should-never-appear-0123456789"
REAL_URLOPEN = urllib.request.urlopen  # 테스트 클라이언트용 (모의 패치 영향 안 받게)


def gemini_payload(results, finish="STOP"):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps({"results": results}, ensure_ascii=False)}]}, "finishReason": finish}]}


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(payload, capture=None):
    def _open(req, timeout=None):
        if capture is not None:
            capture.append({"url": req.full_url, "headers": dict(req.header_items()), "body": json.loads(req.data.decode("utf-8")), "timeout": timeout})
        return FakeResp(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return _open


def ok_results(n):
    return [{"index": i + 1, "category": CATS[i % len(CATS)], "urgency": LEVELS[i % len(LEVELS)], "reason": "근거 문장"} for i in range(n)]


class PromptTests(unittest.TestCase):
    def test_prompt_uses_criteria_rules_without_examples(self):
        p = C.build_prompt(CRITERIA, ["블로그 원고 작성 부탁"])
        for name in CATS + LEVELS:
            self.assertIn(name, p)
        for s in CRITERIA["urgency"]["decision_steps"]["steps"]:
            self.assertIn(s["check"], p)
        self.assertIn(" → ".join(CRITERIA["category_priority"]["order"]), p)
        # 예시 문장·향후 권고는 넣지 않는다
        for b in CRITERIA["urgency"]["boundary_cases"]:
            self.assertNotIn(b["text"], p)
        for e in CRITERIA["category_priority"]["examples"]:
            self.assertNotIn(e["text"], p)
        self.assertNotIn(CRITERIA["urgency"]["unclear_deadline"]["future_recommendation"], p)

    def test_prompt_has_no_answer_data(self):
        with open(os.path.join(ROOT, "data", "answer.json"), encoding="utf-8") as f:
            answers = json.load(f)
        p = C.build_prompt(CRITERIA, ["테스트 문장"])
        for a in answers:
            self.assertNotIn(a["text"], p)


class InputTests(unittest.TestCase):
    def test_rejects_bad_payloads(self):
        for bad in [None, {}, {"texts": []}, {"texts": "x"}, {"texts": [""]}, {"texts": [" "]}, {"texts": [1]},
                    {"texts": ["a"] * 11}, {"texts": ["가" * 501]}]:
            with self.assertRaises(C.ApiError) as cm:
                C.validate_texts(bad)
            self.assertEqual(cm.exception.status, 400)

    def test_server_side_masking_backup(self):
        out = C.validate_texts({"texts": ["연락처 010-9876-5432, 메일 test@example.com, 사번 A-55555, 대표 02-333-4444"]})[0]
        for raw in ["010-9876-5432", "test@example.com", "55555", "02-333-4444"]:
            self.assertNotIn(raw, out)
        self.assertIn("[전화번호]", out)
        self.assertIn("[이메일]", out)
        self.assertIn("[사번]", out)

    def test_masked_text_is_what_is_sent(self):
        cap = []
        C.classify({"texts": ["[이름]님 010-1111-2222 블로그 수정"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(gemini_payload(ok_results(1)), cap))
        sent = cap[0]["body"]["contents"][0]["parts"][0]["text"]
        self.assertNotIn("010-1111-2222", sent)
        self.assertIn("[이름]님 [전화번호] 블로그 수정", sent)


class CallTests(unittest.TestCase):
    def test_success_10_texts(self):
        cap = []
        out = C.classify({"texts": [f"요청 {i}" for i in range(10)]}, env_key=FAKE_KEY, urlopen=fake_urlopen(gemini_payload(ok_results(10)), cap))
        self.assertEqual(len(out["results"]), 10)
        self.assertEqual(out["model"], C.DEFAULT_MODEL)
        self.assertEqual(cap[0]["timeout"], 80)
        self.assertEqual(cap[0]["headers"].get("X-goog-api-key"), FAKE_KEY)  # 키는 헤더로만
        self.assertNotIn(FAKE_KEY, cap[0]["url"])
        self.assertEqual(cap[0]["body"]["generationConfig"]["responseMimeType"], "application/json")
        self.assertTrue(cap[0]["url"].endswith("/v1beta/models/gemini-3.5-flash-lite:generateContent"))

    def test_model_env(self):
        cap = []
        with mock.patch.dict(os.environ, {"GEMINI_MODEL": "gemini-3.6-flash"}):
            out = C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(gemini_payload(ok_results(1)), cap))
        self.assertEqual(out["model"], "gemini-3.6-flash")
        with mock.patch.dict(os.environ, {"GEMINI_MODEL": "../evil?x=1"}):
            with self.assertRaises(C.ApiError) as cm:
                C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(gemini_payload(ok_results(1))))
            self.assertEqual(cm.exception.code, "model_invalid")

    def test_missing_key(self):
        with self.assertRaises(C.ApiError) as cm:
            C.classify({"texts": ["a"]}, env_key="")
        self.assertEqual((cm.exception.status, cm.exception.code), (503, "not_configured"))

    def test_fenced_json_is_accepted(self):
        payload = {"candidates": [{"content": {"parts": [{"text": "```json\n" + json.dumps({"results": ok_results(1)}, ensure_ascii=False) + "\n```"}]}, "finishReason": "STOP"}]}
        out = C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(payload))
        self.assertEqual(len(out["results"]), 1)

    def test_strict_validation_failures(self):
        cases = {
            "count_mismatch": gemini_payload(ok_results(1)),
            "invalid_value": gemini_payload([{"index": 1, "category": "없는유형", "urgency": LEVELS[0], "reason": "r"}, ok_results(2)[1]]),
            "order_mismatch": gemini_payload([dict(ok_results(2)[1], index=2), dict(ok_results(2)[0], index=1)]),
            "invalid_item": gemini_payload([{"index": 1, "category": CATS[0], "urgency": LEVELS[0], "reason": ""}, ok_results(2)[1]]),
            "invalid_json": {"candidates": [{"content": {"parts": [{"text": "분류 결과입니다"}]}, "finishReason": "STOP"}]},
            "blocked": {"promptFeedback": {"blockReason": "SAFETY"}},
            "incomplete": gemini_payload(ok_results(2), finish="MAX_TOKENS"),
        }
        for code, payload in cases.items():
            with self.subTest(code=code):
                with self.assertRaises(C.ApiError) as cm:
                    C.classify({"texts": ["a", "b"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(payload))
                self.assertEqual(cm.exception.code, code)

    def test_reason_is_single_line(self):
        r = ok_results(1)
        r[0]["reason"] = "첫 줄\n둘째 줄"
        out = C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=fake_urlopen(gemini_payload(r)))
        self.assertEqual(out["results"][0]["reason"], "첫 줄 둘째 줄")

    def test_http_errors_and_timeout(self):
        def raiser(exc):
            def _open(req, timeout=None):
                raise exc
            return _open
        cases = [
            (urllib.error.HTTPError("u", 401, "x", {}, None), 502, "upstream_auth"),
            (urllib.error.HTTPError("u", 404, "x", {}, None), 502, "upstream_model"),
            (urllib.error.HTTPError("u", 429, "x", {}, None), 429, "rate_limited"),
            (urllib.error.HTTPError("u", 500, "x", {}, None), 502, "upstream_error"),
            (socket.timeout("t"), 504, "timeout"),
            (urllib.error.URLError(socket.timeout("t")), 504, "timeout"),
            (urllib.error.URLError("dns"), 502, "upstream_unreachable"),
        ]
        for exc, status, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(C.ApiError) as cm:
                    C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=raiser(exc))
                self.assertEqual((cm.exception.status, cm.exception.code), (status, code))
                self.assertNotIn(FAKE_KEY, cm.exception.message)

    def test_retry_without_json_mode_on_400(self):
        calls = []
        def _open(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            calls.append("generationConfig" in body)
            if "generationConfig" in body:
                raise urllib.error.HTTPError("u", 400, "x", {}, None)
            return FakeResp(json.dumps(gemini_payload(ok_results(1))).encode("utf-8"))
        out = C.classify({"texts": ["a"]}, env_key=FAKE_KEY, urlopen=_open)
        self.assertEqual(calls, [True, False])
        self.assertEqual(len(out["results"]), 1)


class HandlerTests(unittest.TestCase):
    """실제 HTTP 서버로 handler를 띄워 요청·응답 형식을 확인 (Gemini는 모의)"""

    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), C.handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, body, raw=None):
        data = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/classify", data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with REAL_URLOPEN(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_no_key_returns_structured_error_without_leaks(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            status, body = self.post({"texts": ["홍길동님 010-1234-5678 수정 요청"]})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "not_configured")
        dump = json.dumps(body, ensure_ascii=False)
        self.assertNotIn("010-1234-5678", dump)
        self.assertNotIn("홍길동", dump)

    def test_success_through_http(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": FAKE_KEY}), \
             mock.patch.object(C.urllib.request, "urlopen", fake_urlopen(gemini_payload(ok_results(2)))):
            status, body = self.post({"texts": ["a", "b"]})
        self.assertEqual(status, 200)
        self.assertEqual(len(body["results"]), 2)
        self.assertNotIn(FAKE_KEY, json.dumps(body))

    def test_bad_json_and_get(self):
        status, body = self.post(None, raw=b"{not json")
        self.assertEqual((status, body["error"]["code"]), (400, "bad_request"))
        try:
            REAL_URLOPEN(f"http://127.0.0.1:{self.port}/api/classify", timeout=5)
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 405)

    def test_internal_error_hides_details(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": FAKE_KEY}), \
             mock.patch.object(C, "load_criteria", side_effect=RuntimeError("secret detail 010-1234-5678")):
            status, body = self.post({"texts": ["a"]})
        self.assertEqual(status, 500)
        self.assertNotIn("secret detail", json.dumps(body, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
