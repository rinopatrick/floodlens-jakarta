"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import json
import signal
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from floodlens.config import (
    APP_VERSION,
    CONTENT_SECURITY_POLICY,
    PUBLIC_DIR,
    Settings,
    load_settings,
)
from floodlens.flood import fetch_flood_overlay
from floodlens.osm import fetch_osm, simplify_osm


class Handler(SimpleHTTPRequestHandler):
    fixture_dir: Path | None = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        """Suppress the default Apache-style log; access logs are JSON."""

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Request-ID", getattr(self, "request_id", ""))
        if not getattr(self, "_cache_control", None):
            path = urlsplit(self.path).path
            if path.startswith("/vendor/"):
                cache = "public, max-age=31536000, immutable"
            elif path == "/" or path.endswith((".html", ".css", ".js")):
                cache = "no-cache"
            else:
                cache = "no-store"
            self.send_header("Cache-Control", cache)
        super().end_headers()

    def send_bytes(self, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self._cache_control = cache
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(
        self,
        message: str,
        status: int = 502,
        code: str = "upstream_unavailable",
    ) -> None:
        body = json.dumps(
            {"error": {"code": code, "message": message}}
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cache_control = "no-store"
        self.end_headers()
        self.wfile.write(body)

    def _write_access_log(self, path: str, started: float) -> None:
        record = {
            "level": "info",
            "event": "request",
            "request_id": self.request_id,
            "method": self.command,
            "path": path,
            "status": getattr(self, "_status", 0),
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
        }
        print(json.dumps(record, separators=(",", ":")), flush=True)

    def _fixture_bytes(self, name: str) -> bytes:
        if self.fixture_dir is None:
            raise RuntimeError("fixture mode is not enabled")
        path = self.fixture_dir / name
        try:
            return path.read_bytes()
        except OSError as exc:
            raise RuntimeError(f"fixture {name} is unavailable") from exc

    def do_GET(self) -> None:
        started = time.monotonic()
        self.request_id = uuid.uuid4().hex[:12]
        self._cache_control = None
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/api/config":
                body = json.dumps(
                    {
                        "fixtureMode": self.fixture_dir is not None,
                        "tileProvider": "esri",
                    },
                    separators=(",", ":"),
                ).encode("utf-8")
                self.send_bytes(body, "application/json; charset=utf-8")
                return
            if parsed.path == "/healthz":
                body = json.dumps(
                    {"status": "ok", "version": APP_VERSION}, separators=(",", ":")
                ).encode("utf-8")
                self.send_bytes(body, "application/json; charset=utf-8")
                return
            if parsed.path == "/api/osm":
                try:
                    if self.fixture_dir is not None:
                        raw = json.loads(self._fixture_bytes("overpass_synthetic.json"))
                        body = simplify_osm(raw)
                    else:
                        refresh = "refresh=1" in parsed.query
                        body = fetch_osm(refresh)
                    self.send_bytes(body, "application/json; charset=utf-8")
                except Exception as exc:  # surfaced as a useful local network message
                    code = (
                        "fixture_unavailable"
                        if self.fixture_dir is not None
                        else "upstream_unavailable"
                    )
                    self.send_error_json(str(exc), code=code)
                return
            if parsed.path == "/api/flood":
                try:
                    if self.fixture_dir is not None:
                        body = self._fixture_bytes("flood.png")
                        if not body.startswith(b"\x89PNG"):
                            raise RuntimeError("fixture flood.png is not a PNG")
                    else:
                        body = fetch_flood_overlay()
                    self.send_bytes(body, "image/png", "public, max-age=3600")
                except Exception as exc:
                    code = (
                        "fixture_unavailable"
                        if self.fixture_dir is not None
                        else "upstream_unavailable"
                    )
                    self.send_error_json(str(exc), code=code)
                return
            super().do_GET()
        finally:
            self._write_access_log(parsed.path, started)


def serve(settings: Settings) -> None:
    server = ThreadingHTTPServer((settings.host, settings.port), Handler)
    server.daemon_threads = True
    Handler.fixture_dir = settings.fixture_dir
    if settings.fixture_dir is not None:
        print(
            json.dumps(
                {
                    "level": "warning",
                    "event": "fixture_mode",
                    "path": str(settings.fixture_dir),
                },
                separators=(",", ":"),
            ),
            flush=True,
        )

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"FloodLens running at http://localhost:{settings.port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    serve(load_settings())
