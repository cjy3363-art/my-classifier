"""로컬 테스트 서버: 정적 파일 + /api/classify (Vercel 없이 API 동작 확인용)

사용법 (프로젝트 폴더에서):
  PowerShell:  $env:GEMINI_API_KEY = "발급받은 키"; py tests/local_server.py
  키 없이 실행하면 /api/classify가 503(not_configured)을 돌려주고, 화면은 규칙 기반으로 대체된다.
접속: http://localhost:8000
배포용 파일이 아니다. 실제 서비스는 Vercel의 api/classify.py가 처리한다.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import classify  # noqa: E402
import models  # noqa: E402

BLOCKED = (".env", ".git", ".vercel", "data/_")  # 비밀값·저장소·비공개 파일은 서빙하지 않는다


class DevHandler(SimpleHTTPRequestHandler):
    def _blocked(self):
        path = self.path.split("?", 1)[0].lstrip("/")
        return any(path.startswith(b) for b in BLOCKED)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/classify":
            return classify.handler.do_GET(self)
        if self.path.split("?", 1)[0] == "/api/models":
            return models.handler.do_GET(self)
        if self._blocked():
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/classify":
            return self.send_error(404)
        return classify.handler.do_POST(self)

    _send = classify.handler._send
    _error = classify.handler._error

    def log_message(self, format, *args):  # 요청 내용은 남기지 않고 경로·상태만
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?", 1)[0]))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print("MEDI TASK 로컬 서버: http://localhost:%d  (GEMINI_API_KEY %s)" % (port, "설정됨" if os.environ.get("GEMINI_API_KEY") else "없음 → 규칙 기반 대체"))
    ThreadingHTTPServer(("127.0.0.1", port), partial(DevHandler, directory=ROOT)).serve_forever()
