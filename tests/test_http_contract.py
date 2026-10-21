import http.client
import json
import threading
from contextlib import contextmanager

import server


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


def get(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", path)
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
    assert response.getheader("Cache-Control") == "no-store"
    assert body == payload
    assert refreshed.status == 200
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
        "error": "OpenStreetMap data could not be fetched: offline"
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
    assert "unexpected map image" in json.loads(body)["error"]
