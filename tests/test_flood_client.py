import pytest

import floodlens.flood as flood


@pytest.fixture(autouse=True)
def clear_flood_cache():
    flood.FLOOD_CACHE.clear()
    yield
    flood.FLOOD_CACHE.clear()


class FakeResponse:
    def __init__(self, body, content_type):
        self.body = body
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.body


def install_response(monkeypatch, body, content_type):
    captured = {"calls": 0}

    def fake_urlopen(request, timeout):
        captured["calls"] += 1
        captured["url"] = request.full_url
        captured["user_agent"] = request.get_header("User-agent")
        captured["timeout"] = timeout
        return FakeResponse(body, content_type)

    monkeypatch.setattr(flood, "urlopen", fake_urlopen)
    return captured


def test_returns_png_and_requests_pilot_bbox(monkeypatch):
    body = b"\x89PNG\r\n\x1a\nsynthetic"
    captured = install_response(monkeypatch, body, "image/png")

    assert flood.fetch_flood_overlay_with_staleness()[0] == body
    assert "bbox=106.73%2C-6.31%2C106.94%2C-6.09" in captured["url"]
    assert "layers=show%3A0" in captured["url"]
    assert captured["timeout"] == 35
    assert "FloodLens" in captured["user_agent"]


def test_cached_overlay_is_reused_until_refresh(monkeypatch):
    captured = install_response(monkeypatch, b"\x89PNG\r\n\x1a\nsynthetic", "image/png")

    flood.fetch_flood_overlay_with_staleness()[0]
    flood.fetch_flood_overlay_with_staleness()[0]
    assert captured["calls"] == 1

    flood.fetch_flood_overlay_with_staleness(force_refresh=True)[0]
    assert captured["calls"] == 2


def test_rejects_html_response(monkeypatch):
    install_response(monkeypatch, b"<html>maintenance</html>", "text/html")

    with pytest.raises(RuntimeError, match="unexpected map image"):
        flood.fetch_flood_overlay_with_staleness()[0]


def test_rejects_non_png_body(monkeypatch):
    install_response(monkeypatch, b"not a png", "image/png")

    with pytest.raises(RuntimeError, match="unexpected map image"):
        flood.fetch_flood_overlay_with_staleness()[0]


def test_timeout_propagates(monkeypatch):
    def fake_urlopen(_request, timeout):
        raise TimeoutError("timed out")

    monkeypatch.setattr(flood, "urlopen", fake_urlopen)

    with pytest.raises(TimeoutError):
        flood.fetch_flood_overlay_with_staleness()[0]


def test_legacy_fetch_wrapper_is_removed():
    assert not hasattr(flood, "fetch_flood_overlay")


def test_with_staleness_reports_stale_after_failure(monkeypatch):
    body = b"\x89PNG\r\n\x1a\nsynthetic"
    install_response(monkeypatch, body, "image/png")

    assert flood.fetch_flood_overlay_with_staleness() == (body, False)

    def fail(_request, _timeout):
        raise TimeoutError("down")

    monkeypatch.setattr(flood, "urlopen", fail)
    flood.FLOOD_CACHE._ttl = 0

    assert flood.fetch_flood_overlay_with_staleness() == (body, True)
