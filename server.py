"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from floodlens.config import HOST, PORT, ROOT
from floodlens.flood import fetch_flood_overlay
from floodlens.osm import fetch_osm


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

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

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
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


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FloodLens running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFloodLens stopped.")
    finally:
        server.server_close()
