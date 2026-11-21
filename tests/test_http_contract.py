import gzip
import http.client
import json
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

import floodlens.cache as cache_module
import floodlens.osm as osm_module
import server
from floodlens.cache import TTLCache
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


def get(port, path, headers=None, *, timeout=5):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    return response, body


def get_osm_after_busy(port):
    deadline = time.monotonic() + 2
    while True:
        response, body = get(port, "/api/osm", timeout=1)
        if response.status != 503 or time.monotonic() >= deadline:
            return response, body
        time.sleep(0.01)


@contextmanager
def blocked_osm(monkeypatch, *, stale=None, fail=False):
    started = threading.Event()
    release = threading.Event()
    cache = TTLCache(60 if stale is None else 0)
    if stale is not None:
        cache.set(stale)

    def fetch():
        started.set()
        if not release.wait(10):
            raise RuntimeError("test did not release upstream")
        if fail:
            raise RuntimeError("upstream failed")
        return b'{"roads":[],"facilities":[]}'

    monkeypatch.setattr(osm_module, "_fetch_osm_from_upstream", fetch)
    monkeypatch.setattr(osm_module, "OSM_CACHE", cache)
    monkeypatch.setattr(server, "OSM_CACHE", cache)
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "api_limiter", RateLimiter(120, 60))
    try:
        yield started, release
    finally:
        release.set()


def test_probes_remain_responsive_when_upstream_slots_are_full(monkeypatch):
    monkeypatch.setattr(server.Handler, "request_slots", threading.BoundedSemaphore(1))
    with running_server() as port, ThreadPoolExecutor(1) as pool:
        with blocked_osm(monkeypatch) as (started, release):
            pending = pool.submit(get, port, "/api/osm")
            assert started.wait(2)

            excess, body = get(port, "/api/flood", timeout=1)
            assert excess.status == 503
            assert excess.getheader("Retry-After") == "2"
            assert json.loads(body)["error"]["code"] == "busy"

            health, body = get(port, "/healthz", timeout=1)
            assert health.status == 200
            assert json.loads(body)["status"] == "ok"

            readiness, body = get(port, "/readyz", timeout=1)
            assert readiness.status == 503
            assert json.loads(body)["status"] == "warming"

            metrics, body = get(port, "/metrics", timeout=1)
            assert metrics.status == 200
            assert b"floodlens_cache_age_seconds" in body

            release.set()
            assert pending.result(timeout=2)[0].status == 200
            assert get(port, "/readyz")[0].status == 200
            assert get_osm_after_busy(port)[0].status == 200


@pytest.mark.parametrize("stale", [None, b'{"roads":[],"facilities":[],"old":true}'])
def test_upstream_followers_time_out_without_waiting_for_the_leader(monkeypatch, stale):
    monkeypatch.setattr(cache_module, "CACHE_FOLLOWER_WAIT_SECONDS", 0.05, raising=False)
    monkeypatch.setattr(server.Handler, "request_slots", threading.BoundedSemaphore(2))
    with running_server() as port, ThreadPoolExecutor(1) as pool:
        with blocked_osm(monkeypatch, stale=stale) as (started, release):
            leader = pool.submit(get, port, "/api/osm")
            assert started.wait(2)

            response, body = get(port, "/api/osm", timeout=1)
            assert not leader.done()
            if stale is None:
                assert response.status == 503
                assert response.getheader("Retry-After") == "2"
                assert json.loads(body)["error"]["code"] == "busy"
            else:
                assert response.status == 200
                assert response.getheader("X-Data-Stale") == "1"
                assert body == stale

            release.set()
            response, body = leader.result(timeout=2)
            assert response.status == 200
            assert response.getheader("X-Data-Stale") is None
            assert json.loads(body) == {"roads": [], "facilities": []}


def test_api_capacity_recovers_after_upstream_failure(monkeypatch):
    monkeypatch.setattr(server.Handler, "request_slots", threading.BoundedSemaphore(1))
    with running_server() as port, ThreadPoolExecutor(1) as pool:
        with blocked_osm(monkeypatch, fail=True) as (started, release):
            pending = pool.submit(get, port, "/api/osm")
            assert started.wait(2)
            release.set()
            response, body = pending.result(timeout=2)
            assert response.status == 502
            assert json.loads(body)["error"]["code"] == "upstream_unavailable"

            monkeypatch.setattr(osm_module, "_fetch_osm_from_upstream", lambda: b'{"roads":[]}')
            assert get_osm_after_busy(port)[0].status == 200


def test_api_capacity_recovers_after_client_disconnects(monkeypatch):
    monkeypatch.setattr(server.Handler, "request_slots", threading.BoundedSemaphore(1))
    with running_server() as port, blocked_osm(monkeypatch) as (started, release):
        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
            client.sendall(b"GET /api/osm HTTP/1.0\r\n\r\n")
            assert started.wait(2)
            client.shutdown(socket.SHUT_RDWR)

        release.set()
        assert get_osm_after_busy(port)[0].status == 200


def test_server_closes_client_socket_when_request_stalls(monkeypatch):
    if server.Handler.timeout is not None:
        monkeypatch.setattr(server.Handler, "timeout", 0.05)

    with running_server() as port:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
            client.sendall(b"GET /healthz HTTP/1.0\r\n")
            assert client.recv(1) == b""

        assert get(port, "/healthz")[0].status == 200


def test_index_is_served():
    with running_server() as port:
        response, body = get(port, "/")

    assert response.status == 200
    assert response.getheader("Content-Type").startswith("text/html")
    assert b"FloodLens" in body


def test_osm_serves_stale_payload_with_header_when_upstream_fails(monkeypatch):
    from floodlens.osm import OSM_CACHE

    stale = json.dumps(
        {"schemaVersion": 1, "roads": [], "facilities": [], "stale": True}
    ).encode()
    OSM_CACHE.clear()
    OSM_CACHE.set(stale)

    def fail(*_args, **_kwargs):
        raise RuntimeError("boom")

    import floodlens.osm as osm_module

    monkeypatch.setattr(osm_module, "_fetch_osm_from_upstream", fail)
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    server.Handler.refresh_cooldown.clear()

    try:
        with running_server() as port:
            response, body = get(port, "/api/osm?refresh=1")
    finally:
        OSM_CACHE.clear()

    assert response.status == 200
    assert body == stale
    assert response.getheader("X-Data-Stale") == "1"


def test_flood_serves_stale_overlay_with_header_when_upstream_fails(monkeypatch):
    import floodlens.flood as flood_module

    stale = b"\x89PNG\r\n\x1a\nstale-overlay"
    flood_module.FLOOD_CACHE.clear()
    flood_module.FLOOD_CACHE.set(stale)

    def fail(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(flood_module, "_fetch_flood_overlay", fail)
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    server.Handler.refresh_cooldown.clear()

    try:
        with running_server() as port:
            response, body = get(port, "/api/flood?refresh=1")
    finally:
        flood_module.FLOOD_CACHE.clear()

    assert response.status == 200
    assert body == stale
    assert response.getheader("X-Data-Stale") == "1"


def test_config_endpoint_reports_live_mode(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)

    with running_server() as port:
        response, body = get(port, "/api/config")

    assert response.status == 200
    payload = json.loads(body)
    assert payload["fixtureMode"] is False
    assert payload["tileProvider"] == "esri"
    assert payload["pilotBounds"] == {
        "south": -6.26,
        "west": 106.78,
        "north": -6.14,
        "east": 106.89,
    }
    assert payload["maxAccessMeters"] == 5000
    assert payload["maxPolygonVertices"] == 512
    assert payload["minPolygonAreaM2"] == 100.0


def test_osm_endpoint_returns_simplified_payload(monkeypatch):
    server.Handler.refresh_cooldown.clear()
    payload = json.dumps({"schemaVersion": 1, "roads": [], "facilities": []}).encode()
    calls = []

    def fake_fetch_osm(refresh=False):
        calls.append(refresh)
        return payload, False

    monkeypatch.setattr(server, "fetch_osm_with_staleness", fake_fetch_osm)

    with running_server() as port:
        response, body = get(port, "/api/osm")
        refreshed, _ = get(port, "/api/osm?refresh=1")

    assert response.status == 200
    assert response.getheader("Content-Type") == "application/json; charset=utf-8"
    from floodlens.config import OSM_BROWSER_TTL

    assert response.getheader("Cache-Control").startswith(
        f"public, max-age={OSM_BROWSER_TTL}"
    )
    assert body == payload
    assert refreshed.status == 200
    assert refreshed.getheader("Cache-Control") == "no-store"
    assert calls == [False, True]


def test_osm_endpoint_reports_upstream_failure(monkeypatch):
    def fail(_refresh=False):
        raise RuntimeError("OpenStreetMap data could not be fetched: offline")

    monkeypatch.setattr(server, "fetch_osm_with_staleness", fail)

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
    monkeypatch.setattr(
        server, "fetch_flood_overlay_with_staleness", lambda _refresh=False: (png, False)
    )

    with running_server() as port:
        response, body = get(port, "/api/flood")

    assert response.status == 200
    assert response.getheader("Content-Type") == "image/png"
    from floodlens.config import FLOOD_BROWSER_TTL

    assert response.getheader("Cache-Control") == f"public, max-age={FLOOD_BROWSER_TTL}"
    assert body == png


def test_flood_endpoint_reports_upstream_failure(monkeypatch):
    def fail(_refresh=False):
        raise RuntimeError("BNPB returned an unexpected map image response")

    monkeypatch.setattr(server, "fetch_flood_overlay_with_staleness", fail)

    with running_server() as port:
        response, body = get(port, "/api/flood")

    assert response.status == 502
    assert "Layer BNPB tidak tersedia" in json.loads(body)["error"]["message"]


def test_osm_supports_gzip_and_etag(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    payload = json.dumps(
        {
            "schemaVersion": 1,
            "dataTimestamp": "2026-10-21T00:00:00Z",
            "roads": [{"id": "x" * 2000}],
            "facilities": [],
        }
    ).encode()
    monkeypatch.setattr(server, "fetch_osm_with_staleness", lambda _refresh=False: (payload, False))

    with running_server() as port:
        first, body = get(port, "/api/osm", headers={"Accept-Encoding": "gzip"})
        etag = first.getheader("ETag")
        second, empty = get(port, "/api/osm", headers={"If-None-Match": etag})

    assert first.status == 200
    assert first.getheader("Content-Encoding") == "gzip"
    assert first.getheader("Vary") == "Accept-Encoding"
    assert first.getheader("X-Data-Timestamp") == "2026-10-21T00:00:00Z"
    assert gzip.decompress(body) == payload
    assert etag
    assert second.status == 304
    assert empty == b""


def test_api_responses_carry_rate_limit_headers(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(
        server,
        "fetch_osm_with_staleness",
        lambda _refresh=False: (b'{"roads":[],"facilities":[]}', False),
    )
    monkeypatch.setattr(
        server,
        "fetch_flood_overlay_with_staleness",
        lambda _refresh=False: (b"\x89PNG\r\n\x1a\n", False),
    )

    with running_server() as port:
        osm, _ = get(port, "/api/osm")
        flood, _ = get(port, "/api/flood")

    assert osm.getheader("X-RateLimit-Limit") == "120"
    assert osm.getheader("X-RateLimit-Remaining") is not None
    assert flood.getheader("X-RateLimit-Limit") == "120"


def test_oversize_request_target_is_rejected():
    from floodlens.config import MAX_REQUEST_BYTES

    target = "/api/osm?" + ("x" * MAX_REQUEST_BYTES)
    assert len(target.encode("utf-8")) > MAX_REQUEST_BYTES


def test_osm_rate_limit(monkeypatch):
    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "api_limiter", RateLimiter(1, 60))
    monkeypatch.setattr(
        server,
        "fetch_osm_with_staleness",
        lambda _refresh=False: (b'{"roads":[],"facilities":[]}', False),
    )

    with running_server() as port:
        first, _body = get(port, "/api/osm")
        second, body = get(port, "/api/osm")

    assert first.status == 200
    assert second.status == 429
    assert second.getheader("Retry-After")
    assert json.loads(body)["error"]["code"] == "rate_limited"


def test_flood_refresh_cooldown_blocks_second_refresh(monkeypatch):
    from floodlens.limits import Cooldown

    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "refresh_cooldown", Cooldown(seconds=30))
    monkeypatch.setattr(
        server,
        "fetch_flood_overlay_with_staleness",
        lambda _refresh=False: (b"\x89PNG\r\n\x1a\n", False),
    )

    with running_server() as port:
        first, _ = get(port, "/api/flood?refresh=1")
        second, _ = get(port, "/api/flood?refresh=1")

    assert first.status == 200
    assert first.getheader("X-Refresh") is None
    assert second.status == 200
    assert second.getheader("X-Refresh") == "cooldown"
    assert second.getheader("X-Refresh-Retry-After") is not None


def test_osm_refresh_cooldown_blocks_second_refresh(monkeypatch):
    from floodlens.limits import Cooldown

    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "refresh_cooldown", Cooldown(seconds=30))
    monkeypatch.setattr(
        server,
        "fetch_osm_with_staleness",
        lambda _refresh=False: (b'{"roads":[],"facilities":[]}', False),
    )

    with running_server() as port:
        first, _ = get(port, "/api/osm?refresh=1")
        second, _ = get(port, "/api/osm?refresh=1")

    assert first.status == 200
    assert first.getheader("X-Refresh") is None
    assert second.status == 200
    assert second.getheader("X-Refresh") == "cooldown"
    assert second.getheader("X-Refresh-Retry-After") is not None



def test_refresh_cooldown_is_scoped_per_route(monkeypatch):
    from floodlens.limits import Cooldown

    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "refresh_cooldown", Cooldown(seconds=30))
    monkeypatch.setattr(
        server,
        "fetch_osm_with_staleness",
        lambda _refresh=False: (b'{"roads":[],"facilities":[]}', False),
    )
    monkeypatch.setattr(
        server,
        "fetch_flood_overlay_with_staleness",
        lambda _refresh=False: (b"\x89PNG\r\n\x1a\n", False),
    )

    with running_server() as port:
        _, _ = get(port, "/api/osm?refresh=1")
        flood, _ = get(port, "/api/flood?refresh=1")

    assert flood.status == 200
    assert flood.getheader("X-Refresh") is None


def test_api_response_prelude_is_shared_between_osm_and_flood(monkeypatch):
    from floodlens.limits import Cooldown, RateLimiter

    monkeypatch.setattr(server.Handler, "fixture_dir", None)
    monkeypatch.setattr(server.Handler, "refresh_cooldown", Cooldown(seconds=30))
    monkeypatch.setattr(server.Handler, "api_limiter", RateLimiter(120, 60))
    seen = {}

    def fake_fetch_osm(refresh=False):
        seen["osm_refresh"] = refresh
        return b'{"roads":[],"facilities":[]}', False

    def fake_fetch_flood(refresh=False):
        seen["flood_refresh"] = refresh
        return b"\x89PNG\r\n\x1a\n", False

    monkeypatch.setattr(server, "fetch_osm_with_staleness", fake_fetch_osm)
    monkeypatch.setattr(server, "fetch_flood_overlay_with_staleness", fake_fetch_flood)

    with running_server() as port:
        osm, _ = get(port, "/api/osm?refresh=1")
        flood, _ = get(port, "/api/flood?refresh=1")

    assert osm.getheader("X-RateLimit-Limit") == flood.getheader("X-RateLimit-Limit")
    assert osm.getheader("X-Data-Stale") == flood.getheader("X-Data-Stale")
    assert seen == {"osm_refresh": True, "flood_refresh": True}
