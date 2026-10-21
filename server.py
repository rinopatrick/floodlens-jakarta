"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from floodlens.config import EAST, FLOOD_SERVICE, HOST, NORTH, PORT, ROOT, SOUTH, WEST
from floodlens.osm import fetch_osm


def fetch_flood_overlay() -> bytes:
    params = urlencode(
        {
            "bbox": f"{WEST - 0.05},{SOUTH - 0.05},{EAST + 0.05},{NORTH + 0.05}",
            "bboxSR": "4326",
            "imageSR": "4326",
            "size": "1440,960",
            "format": "png32",
            "transparent": "true",
            "layers": "show:0",
            "f": "image",
        }
    )
    request = Request(
        f"{FLOOD_SERVICE}/export?{params}",
        headers={"User-Agent": "FloodLens/0.1 local portfolio demonstration"},
    )
    with urlopen(request, timeout=35) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read()
    if "image/" not in content_type or not body.startswith(b"\x89PNG"):
        raise RuntimeError("BNPB returned an unexpected map image response")
    return body


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
