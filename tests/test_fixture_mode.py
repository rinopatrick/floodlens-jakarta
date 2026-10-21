import http.client
import json
import threading
from contextlib import contextmanager
from pathlib import Path

import server

FIXTURES = Path(__file__).parent / "fixtures"


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


def test_fixture_osm_never_calls_upstream(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", FIXTURES)
    monkeypatch.setattr(
        server, "fetch_osm", lambda *_args: (_ for _ in ()).throw(AssertionError("upstream"))
    )

    with running_server() as port:
        response, body = get(port, "/api/osm?refresh=1")

    payload = json.loads(body)
    assert response.status == 200
    assert payload["schemaVersion"] == 1
    assert len(payload["roads"]) == 10
    assert len(payload["facilities"]) == 5


def test_fixture_flood_never_calls_upstream(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", FIXTURES)
    monkeypatch.setattr(
        server,
        "fetch_flood_overlay",
        lambda *_args: (_ for _ in ()).throw(AssertionError("upstream")),
    )

    with running_server() as port:
        response, body = get(port, "/api/flood")

    assert response.status == 200
    assert response.getheader("Content-Type") == "image/png"
    assert body.startswith(b"\x89PNG")


def test_missing_fixture_returns_clear_error(monkeypatch, tmp_path):
    monkeypatch.setattr(server.Handler, "fixture_dir", tmp_path)

    with running_server() as port:
        response, body = get(port, "/api/osm")

    assert response.status == 502
    assert "fixture overpass_synthetic.json is unavailable" in json.loads(body)["error"][
        "message"
    ]


def test_fixture_mode_is_off_by_default(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server, "fetch_osm", lambda _refresh=False: b'{"roads":[]}')

    with running_server() as port:
        response, body = get(port, "/api/osm")

    assert response.status == 200
    assert body == b'{"roads":[]}'
