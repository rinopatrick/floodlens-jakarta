"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import json
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from floodlens.config import APP_VERSION, HOST, PORT, PUBLIC_DIR
from floodlens.flood import fetch_flood_overlay
from floodlens.osm import fetch_osm


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        """Suppress the default Apache-style log; access logs are JSON."""

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Request-ID", getattr(self, "request_id", ""))
        super().end_headers()

    def send_bytes(self, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 502) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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

    def do_GET(self) -> None:
        started = time.monotonic()
        self.request_id = uuid.uuid4().hex[:12]
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/healthz":
                body = json.dumps(
                    {"status": "ok", "version": APP_VERSION}, separators=(",", ":")
                ).encode("utf-8")
                self.send_bytes(body, "application/json; charset=utf-8")
                return
            if parsed.path == "/api/osm":
                try:
                    refresh = "refresh=1" in parsed.query
                    self.send_bytes(fetch_osm(refresh), "application/json; charset=utf-8")
                except Exception as exc:  # surfaced as a useful local network message
                    self.send_error_json(str(exc))
                return
            if parsed.path == "/api/flood":
                try:
                    self.send_bytes(
                        fetch_flood_overlay(), "image/png", "public, max-age=3600"
                    )
                except Exception as exc:
                    self.send_error_json(str(exc))
                return
            super().do_GET()
        finally:
            self._write_access_log(parsed.path, started)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FloodLens running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFloodLens stopped.")
    finally:
        server.server_close()
