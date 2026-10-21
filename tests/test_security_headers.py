import http.client
import json
import threading
from contextlib import contextmanager

import server
from floodlens.config import CONTENT_SECURITY_POLICY


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


def test_health_endpoint_is_independent_of_upstream(monkeypatch):
    def fail(*_args, **_kwargs):
        raise AssertionError("health check must not call upstream")

    monkeypatch.setattr(server, "fetch_osm", fail)
    monkeypatch.setattr(server, "fetch_flood_overlay", fail)

    with running_server() as port:
        response, body = get(port, "/healthz")

    assert response.status == 200
    assert response.getheader("Content-Type") == "application/json; charset=utf-8"
    assert json.loads(body) == {"status": "ok", "version": "0.2.0"}


def test_security_headers_are_present_on_static_and_api_responses(monkeypatch):
    monkeypatch.setattr(server, "fetch_osm", lambda _refresh=False: b"{}")
    monkeypatch.setattr(server, "fetch_flood_overlay", lambda: b"\x89PNG\r\n\x1a\n")

    with running_server() as port:
        responses = [get(port, "/")[0], get(port, "/healthz")[0], get(port, "/api/osm")[0]]

    for response in responses:
        assert response.getheader("Content-Security-Policy") == CONTENT_SECURITY_POLICY
        assert "script-src 'self'" in response.getheader("Content-Security-Policy")
        assert response.getheader("X-Content-Type-Options") == "nosniff"
        assert response.getheader("Referrer-Policy") == "no-referrer"
        assert response.getheader("X-Frame-Options") == "DENY"
        assert response.getheader("Cross-Origin-Opener-Policy") == "same-origin"
        assert response.getheader("Cross-Origin-Resource-Policy") == "same-origin"
        assert "geolocation=()" in response.getheader("Permissions-Policy")
        assert response.getheader("X-Request-ID")


def test_static_cache_policy(monkeypatch):
    monkeypatch.setattr(server, "fetch_osm", lambda _refresh=False: b"{}")

    with running_server() as port:
        index = get(port, "/")[0]
        stylesheet = get(port, "/styles.css")[0]
        module = get(port, "/src/app.js")[0]
        vendor = get(port, "/vendor/leaflet/leaflet.js")[0]

    assert index.getheader("Cache-Control") == "no-cache"
    assert stylesheet.getheader("Cache-Control") == "no-cache"
    assert module.getheader("Cache-Control") == "no-cache"
    assert vendor.getheader("Cache-Control") == "public, max-age=31536000, immutable"


def test_access_log_is_json_without_query_string(capsys):
    with running_server() as port:
        get(port, "/healthz?token=secret")

    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    records = [json.loads(line) for line in lines]
    request = next(record for record in records if record.get("event") == "request")

    assert request["method"] == "GET"
    assert request["path"] == "/healthz"
    assert request["status"] == 200
    assert request["request_id"]
    assert isinstance(request["duration_ms"], (int, float))
    assert "secret" not in json.dumps(request)
