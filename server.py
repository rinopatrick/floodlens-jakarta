"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
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
from floodlens.limits import Cooldown, RateLimiter
from floodlens.osm import OSM_CACHE, fetch_osm, simplify_osm


class Handler(SimpleHTTPRequestHandler):
    fixture_dir: Path | None = None
    request_slots = threading.BoundedSemaphore(16)
    api_limiter = RateLimiter(limit=120, window_seconds=60)
    refresh_cooldown = Cooldown(seconds=30)

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

    def send_bytes(
        self,
        body: bytes,
        content_type: str,
        cache: str = "no-store",
        *,
        etag: bool = False,
        compress: bool = False,
        extra_headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        etag_value = f'"{hashlib.sha256(body).hexdigest()}"' if etag else None
        if etag_value and self.headers.get("If-None-Match") == etag_value:
            self.send_response(304)
            self.send_header("ETag", etag_value)
            self.send_header("Cache-Control", cache)
            self.send_header("Vary", "Accept-Encoding")
            self._cache_control = cache
            self.end_headers()
            return

        encoded = body
        content_encoding = None
        if compress and len(body) >= 1024 and "gzip" in self.headers.get(
            "Accept-Encoding", ""
        ).lower():
            encoded = gzip.compress(body, compresslevel=6)
            content_encoding = "gzip"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", cache)
        if etag_value:
            self.send_header("ETag", etag_value)
        self.send_header("Vary", "Accept-Encoding")
        if content_encoding:
            self.send_header("Content-Encoding", content_encoding)
        for name, value in extra_headers:
            if value:
                self.send_header(name, value)
        self._cache_control = cache
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(
        self,
        message: str,
        status: int = 502,
        code: str = "upstream_unavailable",
        retry_after: int | None = None,
    ) -> None:
        body = json.dumps(
            {"error": {"code": code, "message": message}}
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
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

    def _write_error_log(self, path: str, exc: Exception) -> None:
        record = {
            "level": "error",
            "event": "upstream_error",
            "request_id": self.request_id,
            "path": path,
            "error_type": type(exc).__name__,
            "error": str(exc),
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

    def _client_key(self) -> str:
        if os.environ.get("FLOODLENS_TRUST_PROXY") == "1":
            forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if forwarded:
                return forwarded
        return self.client_address[0]

    def _allow_api(self, path: str) -> bool:
        client = self._client_key()
        allowed, retry = self.api_limiter.allow(f"{client}:{path}")
        if allowed:
            return True
        self.send_error_json(
            "Terlalu banyak permintaan. Coba lagi.",
            status=429,
            code="rate_limited",
            retry_after=retry,
        )
        return False

    def do_GET(self) -> None:
        started = time.monotonic()
        self.request_id = uuid.uuid4().hex[:12]
        self._cache_control = None
        parsed = urlsplit(self.path)

        if not self.request_slots.acquire(blocking=False):
            self.send_error_json(
                "Server sedang sibuk. Coba lagi.",
                status=503,
                code="busy",
                retry_after=2,
            )
            self._write_access_log(parsed.path, started)
            return

        try:
            if parsed.path in {"/api/osm", "/api/flood"} and not self._allow_api(
                parsed.path
            ):
                return

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
                fixture = self.fixture_dir is not None
                try:
                    if fixture:
                        raw = json.loads(self._fixture_bytes("overpass_synthetic.json"))
                        body = simplify_osm(raw)
                        self.send_bytes(
                            body,
                            "application/json; charset=utf-8",
                            cache="no-store",
                        )
                    else:
                        refresh = "refresh=1" in parsed.query
                        headers: list[tuple[str, str]] = []
                        if refresh:
                            allowed, _retry = self.refresh_cooldown.allow(
                                self._client_key()
                            )
                            if not allowed:
                                refresh = False
                                headers.append(("X-Refresh", "cooldown"))
                        body = fetch_osm(refresh)
                        payload = json.loads(body)
                        timestamp = payload.get("dataTimestamp", "")
                        if timestamp:
                            headers.append(("X-Data-Timestamp", str(timestamp)))
                        age = OSM_CACHE.age()
                        if age is not None:
                            headers.append(("X-Data-Age", str(int(age))))
                        self.send_bytes(
                            body,
                            "application/json; charset=utf-8",
                            cache=(
                                "no-store"
                                if refresh
                                else "public, max-age=60, stale-while-revalidate=300"
                            ),
                            etag=not refresh,
                            compress=True,
                            extra_headers=tuple(headers),
                        )
                except Exception as exc:
                    self._write_error_log(parsed.path, exc)
                    if fixture:
                        self.send_error_json(
                            "Data contoh tidak tersedia.",
                            code="fixture_unavailable",
                        )
                    else:
                        self.send_error_json(
                            "Sumber data OpenStreetMap tidak tersedia. Coba lagi beberapa saat.",
                            code="upstream_unavailable",
                            retry_after=5,
                        )
                return
            if parsed.path == "/api/flood":
                fixture = self.fixture_dir is not None
                try:
                    if fixture:
                        body = self._fixture_bytes("flood.png")
                        if not body.startswith(b"\x89PNG"):
                            raise RuntimeError("fixture flood.png is not a PNG")
                    else:
                        body = fetch_flood_overlay()
                    self.send_bytes(
                        body,
                        "image/png",
                        "public, max-age=3600",
                        etag=True,
                    )
                except Exception as exc:
                    self._write_error_log(parsed.path, exc)
                    if fixture:
                        self.send_error_json(
                            "Data contoh tidak tersedia.",
                            code="fixture_unavailable",
                        )
                    else:
                        self.send_error_json(
                            "Layer BNPB tidak tersedia. "
                            "Peta dasar dan analisis jalan tetap bisa digunakan.",
                            code="upstream_unavailable",
                            retry_after=5,
                        )
                return
            super().do_GET()
        finally:
            self.request_slots.release()
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
