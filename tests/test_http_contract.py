import gzip
import http.client
import json
import threading
from contextlib import contextmanager

import server
from floodlens.limits import RateLimiter


@contextmanager
def running_server():
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def get(port, path, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", path, headers=headers or {})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


def test_index_is_served():
    with running_server() as port:
        response, body = get(port, "/")

    assert response.status == 200
    assert response.getheader("Content-Type").startswith("text/html")
    assert b"FloodLens" in body


def test_config_endpoint_reports_live_mode(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)

    with running_server() as port:
        response, body = get(port, "/api/config")

    assert response.status == 200
    assert json.loads(body) == {"fixtureMode": False, "tileProvider": "esri"}


def test_osm_endpoint_returns_simplified_payload(monkeypatch):
    payload = json.dumps({"schemaVersion": 1, "roads": [], "facilities": []}).encode()
    calls = []

    def fake_fetch_osm(refresh=False):
        calls.append(refresh)
        return payload

    monkeypatch.setattr(server, "fetch_osm", fake_fetch_osm)

    with running_server() as port:
        response, body = get(port, "/api/osm")
        refreshed, _ = get(port, "/api/osm?refresh=1")

    assert response.status == 200
    assert response.getheader("Content-Type") == "application/json; charset=utf-8"
    assert response.getheader("Cache-Control").startswith("public, max-age=60")
    assert body == payload
    assert refreshed.status == 200
    assert refreshed.getheader("Cache-Control") == "no-store"
    assert calls == [False, True]


def test_osm_endpoint_reports_upstream_failure(monkeypatch):
    def fail(_refresh=False):
        raise RuntimeError("OpenStreetMap data could not be fetched: offline")

    monkeypatch.setattr(server, "fetch_osm", fail)

    with running_server() as port:
        response, body = get(port, "/api/osm")

    assert response.status == 502
    assert response.getheader("Content-Type") == "application/json; charset=utf-8"
    assert json.loads(body) == {
        "error": {
            "code": "upstream_unavailable",
            "message": "Sumber data OpenStreetMap tidak tersedia. Coba lagi beberapa saat.",
        }
    }


def test_flood_endpoint_returns_cached_png(monkeypatch):
    png = b"\x89PNG\r\n\x1a\nsynthetic"
    monkeypatch.setattr(server, "fetch_flood_overlay", lambda: png)

    with running_server() as port:
        response, body = get(port, "/api/flood")

    assert response.status == 200
    assert response.getheader("Content-Type") == "image/png"
    assert response.getheader("Cache-Control") == "public, max-age=3600"
    assert body == png


def test_flood_endpoint_reports_upstream_failure(monkeypatch):
    def fail():
        raise RuntimeError("BNPB returned an unexpected map image response")

    monkeypatch.setattr(server, "fetch_flood_overlay", fail)

    with running_server() as port:
        response, body = get(port, "/api/flood")

    assert response.status == 502
    assert "Layer BNPB tidak tersedia" in json.loads(body)["error"]["message"]


def test_osm_supports_gzip_and_etag(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    payload = json.dumps(
        {"schemaVersion": 1, "roads": [{"id": "x" * 2000}], "facilities": []}
    ).encode()
    monkeypatch.setattr(server, "fetch_osm", lambda _refresh=False: payload)

    with running_server() as port:
        first, body = get(port, "/api/osm", headers={"Accept-Encoding": "gzip"})
        etag = first.getheader("ETag")
        second, empty = get(port, "/api/osm", headers={"If-None-Match": etag})

    assert first.status == 200
    assert first.getheader("Content-Encoding") == "gzip"
    assert first.getheader("Vary") == "Accept-Encoding"
    assert gzip.decompress(body) == payload
    assert etag
    assert second.status == 304
    assert empty == b""


def test_osm_rate_limit(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "api_limiter", RateLimiter(1, 60))
    monkeypatch.setattr(
        server, "fetch_osm", lambda _refresh=False: b'{"roads":[],"facilities":[]}'
    )

    with running_server() as port:
        first, _body = get(port, "/api/osm")
        second, body = get(port, "/api/osm")

    assert first.status == 200
    assert second.status == 429
    assert second.getheader("Retry-After")
    assert json.loads(body)["error"]["code"] == "rate_limited"
