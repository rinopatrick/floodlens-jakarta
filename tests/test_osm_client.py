import io
import json

import pytest

from floodlens import osm
from floodlens.cache import TTLCache


@pytest.fixture
def upstream(monkeypatch):
    monkeypatch.setattr(osm, "OSM_CACHE", TTLCache(10))
    monkeypatch.setattr(osm, "OVERPASS_ENDPOINTS", ["https://first.test", "https://second.test"])
    monkeypatch.setattr(osm.time, "sleep", lambda _seconds: None)
    calls = []

    def install(payloads):
        responses = iter(payloads)

        def fake_urlopen(request, timeout):
            calls.append(request.full_url)
            return io.BytesIO(json.dumps(next(responses)).encode())

        monkeypatch.setattr(osm, "urlopen", fake_urlopen)
        return calls

    return install


def test_invalid_first_endpoint_falls_back(upstream):
    valid = {"elements": [], "osm3s": {"timestamp_osm_base": "good"}}
    calls = upstream([{"remark": "runtime error: Query timed out"}, valid])

    value, stale = osm.fetch_osm_with_staleness()

    assert (value, stale) == (osm.simplify_osm(valid), False)
    assert calls == ["https://first.test", "https://second.test"]


@pytest.mark.parametrize("force_refresh", [False, True])
def test_all_invalid_preserves_known_good_cache_as_stale(upstream, monkeypatch, force_refresh):
    now = [100.0]
    monkeypatch.setattr(osm, "OSM_CACHE", TTLCache(10, lambda: now[0]))
    good = {
        "elements": [
            {
                "type": "node",
                "id": 1,
                "lat": -6.2,
                "lon": 106.83,
                "tags": {"amenity": "hospital", "name": "Known good hospital"},
            }
        ],
        "osm3s": {"timestamp_osm_base": "known-good"},
    }
    upstream([good])
    original, stale = osm.fetch_osm_with_staleness()
    assert stale is False
    if not force_refresh:
        now[0] += 20
    invalid = [{"elements": None}, {"elements": [], "remark": "runtime error"}]
    calls = upstream(invalid * 2)

    assert osm.fetch_osm_with_staleness(force_refresh) == (original, True)
    assert calls[-2:] == ["https://first.test", "https://second.test"]
    assert osm.OSM_CACHE.age() == (0 if force_refresh else 20)
    assert osm.fetch_osm_with_staleness(True) == (original, True)
    assert len(calls) == 5


def test_all_invalid_with_cold_cache_raises_existing_fetch_error(upstream):
    calls = upstream([{}, {"elements": "not a list"}])

    with pytest.raises(RuntimeError, match="OpenStreetMap data could not be fetched"):
        osm.fetch_osm_with_staleness()

    assert calls == ["https://first.test", "https://second.test"]
    assert osm.OSM_CACHE.get() is None
