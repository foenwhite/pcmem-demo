"""The demo's HTTP surface: static UI, read-only views, settings, build, ask.

Deliberately small and stdlib-only. It is not an agent framework and it does
not wrap the project's REST server: it calls the same ``sci_rag`` service
objects that the CLI, REST and evaluation paths call.
"""

from __future__ import annotations

import json
import queue
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import pipeline, views
from .jobs import BuildJob
from .paths import WEB_DIR
from .runtime import AsyncRuntime
from .secrets import SecretError, clear_key, load_api, redact, save_api

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "form-action 'self'; frame-ancestors 'none'"
)

_job = BuildJob()
_runtime: AsyncRuntime | None = None


def _sanitize(message: object) -> str:
    api = load_api()
    return redact(message, api["key"] if api else None)


class Handler(BaseHTTPRequestHandler):
    server_version = "PCMemDemo/1.0"
    protocol_version = "HTTP/1.0"

    # -- helpers ---------------------------------------------------------
    def _headers(self, status: int, content_type: str, length: int | None = None,
                 extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": _sanitize(message)}})

    def _read_json(self, limit: int = 64 * 1024) -> dict:
        length = self.headers.get("Content-Length")
        if length is None:
            raise ValueError("missing Content-Length")
        try:
            size = int(length)
        except ValueError as exc:
            raise ValueError("bad Content-Length") from exc
        if size < 0 or size > limit:
            raise ValueError("request body too large")
        body = self.rfile.read(size)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("body is not JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("body must be a JSON object")
        return payload

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        port = self.server.server_port
        return origin in {
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
            f"http://[::1]:{port}",
        }

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        path = urlsplit(self.path).path
        sys.stderr.write(f"[demo] {self.command} {path} → {args[1] if len(args) > 1 else ''}\n")

    # -- routes ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        path = parsed.path
        try:
            if path in STATIC:
                self._static(path)
                return
            if path == "/api/state":
                self._json(200, _runtime.run(views.state()))
                return
            if path == "/api/documents":
                self._json(200, _runtime.run(views.documents()))
                return
            if path.startswith("/api/documents/"):
                document_id = path.rsplit("/", 1)[-1]
                payload = _runtime.run(views.document_detail(document_id))
                if payload is None:
                    self._error(404, "document_not_found", "没有这个文档")
                else:
                    self._json(200, payload)
                return
            if path == "/api/graph":
                self._json(200, _runtime.run(views.graph()))
                return
            if path == "/api/evidence":
                ids = parse_qs(parsed.query).get("ids", [""])[0]
                chunk_ids = [value for value in ids.split(",") if value]
                self._json(200, {"items": _runtime.run(views.evidence(chunk_ids))})
                return
            if path == "/api/superseded":
                question = parse_qs(parsed.query).get("q", [""])[0][:500]
                self._json(200, _runtime.run(pipeline.superseded_search(question)))
                return
            if path == "/api/build/status":
                self._json(200, _job.snapshot())
                return
            if path == "/api/health":
                self._json(200, {"ok": True})
                return
            self._error(404, "not_found", "未知路径")
        except Exception as exc:
            self._server_error(exc)

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if not self._same_origin():
            self._error(403, "bad_origin", "只接受本页面发起的请求")
            return
        try:
            if path == "/api/settings":
                body = self._read_json()
                view = save_api(
                    base_url=body.get("base_url"),
                    api_key=body.get("api_key"),
                    answer_model=body.get("answer_model"),
                    extraction_model=body.get("extraction_model"),
                )
                self._json(200, {"saved": True, "api": view})
                return
            if path == "/api/settings/clear-key":
                self._json(200, {"cleared": True, "api": clear_key()})
                return
            if path == "/api/settings/test":
                api = load_api()
                if api is None:
                    self._error(400, "no_key", "还没有保存模型 API")
                    return
                try:
                    result = _runtime.run(pipeline.test_endpoint(api), timeout=120)
                except Exception as exc:
                    self._error(400, "test_failed", f"{type(exc).__name__}: {exc}")
                    return
                self._json(200, result)
                return
            if path == "/api/build":
                body = self._read_json(limit=2048)
                if not _job.begin():
                    self._error(409, "build_running", "已有构建在运行")
                    return
                _job.progress("开始", "构建任务已启动", 1)
                with_communities = bool(body.get("with_communities"))
                future = _runtime.submit(
                    pipeline.run_build(_job.progress, with_communities=with_communities)
                )

                def finish(completed) -> None:
                    try:
                        _job.finish(completed.result())
                    except Exception as exc:
                        _job.fail(_sanitize(f"{type(exc).__name__}: {exc}"))
                        sys.stderr.write(_sanitize(traceback.format_exc()) + "\n")

                future.add_done_callback(finish)
                self._json(200, {"started": True, "job": _job.snapshot()})
                return
            if path == "/api/ask":
                self._ask()
                return
            self._error(404, "not_found", "未知路径")
        except (ValueError, SecretError) as exc:
            self._error(400, "bad_request", str(exc))
        except Exception as exc:
            self._server_error(exc)

    # -- implementations -------------------------------------------------
    def _static(self, path: str) -> None:
        name, content_type = STATIC[path]
        target = (WEB_DIR / name).resolve()
        if WEB_DIR.resolve() not in target.parents:
            self._error(404, "not_found", "未知资源")
            return
        try:
            body = target.read_bytes()
        except OSError:
            self._error(404, "not_found", "资源不存在")
            return
        self._headers(200, content_type, len(body))
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _ask(self) -> None:
        body = self._read_json(limit=32 * 1024)
        question = body.get("question")
        if not isinstance(question, str) or not question.strip():
            self._error(400, "empty_question", "问题不能为空")
            return
        project_id = body.get("project_id")
        if project_id is not None and not isinstance(project_id, str):
            self._error(400, "bad_project", "项目筛选格式不正确")
            return
        external_only = bool(body.get("external_only"))
        use_hyde = bool(body.get("use_hyde"))
        self._headers(200, "text/event-stream; charset=utf-8", extra={
            "Connection": "close", "X-Accel-Buffering": "no",
        })
        events: queue.Queue = queue.Queue()

        async def produce() -> None:
            try:
                async for event in pipeline.ask_stream(
                    question, project_id=project_id, external_only=external_only,
                    use_hyde=use_hyde,
                ):
                    events.put(event)
            except Exception as exc:
                events.put({
                    "type": "error",
                    "data": {"code": "ask_failed",
                             "message": _sanitize(f"{type(exc).__name__}: {exc}")},
                })
            finally:
                events.put(None)

        _runtime.submit(produce())
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        while True:
            event = events.get()
            if event is None:
                break
            payload = json.dumps(event, ensure_ascii=False)
            try:
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

    def _server_error(self, exc: Exception) -> None:
        sys.stderr.write(_sanitize(traceback.format_exc()) + "\n")
        try:
            self._error(500, "internal_error", _sanitize(f"{type(exc).__name__}: {exc}"))
        except Exception:
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_server(host: str, port: int) -> Server:
    return Server((host, port), Handler)


def set_runtime(runtime: AsyncRuntime) -> None:
    global _runtime
    _runtime = runtime


def runtime() -> AsyncRuntime:
    if _runtime is None:
        raise RuntimeError("runtime not initialized")
    return _runtime
