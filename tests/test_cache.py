import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from floodlens.cache import TTLCache


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_fresh_value_is_reused():
    clock = FakeClock()
    cache = TTLCache(10, clock)
    calls = []

    assert cache.get_or_fetch_with_staleness(
        lambda: calls.append(1) or b"value"
    ) == (b"value", False)
    assert cache.get_or_fetch_with_staleness(
        lambda: calls.append(1) or b"other"
    ) == (b"value", False)
    assert len(calls) == 1


def test_expired_value_is_fetched_again():
    clock = FakeClock()
    cache = TTLCache(10, clock)
    values = iter([b"old", b"new"])

    assert cache.get_or_fetch_with_staleness(lambda: next(values)) == (b"old", False)
    clock.advance(10)
    assert cache.get_or_fetch_with_staleness(lambda: next(values)) == (b"new", False)


def test_force_refresh_bypasses_fresh_value():
    clock = FakeClock()
    cache = TTLCache(10, clock)
    values = iter([b"old", b"new"])

    assert cache.get_or_fetch_with_staleness(lambda: next(values)) == (b"old", False)
    assert cache.get_or_fetch_with_staleness(
        lambda: next(values), force_refresh=True
    ) == (b"new", False)
    assert cache.get_stale() == b"new"


def test_stale_value_is_served_when_fetch_fails():
    clock = FakeClock()
    cache = TTLCache(10, clock)

    cache.get_or_fetch_with_staleness(lambda: b"stale")
    clock.advance(60)

    def fail():
        raise RuntimeError("upstream down")

    assert cache.get_or_fetch_with_staleness(fail) == (b"stale", True)


def test_fetch_error_propagates_without_stale_value():
    cache = TTLCache(10, FakeClock())

    def fail():
        raise RuntimeError("upstream down")

    with pytest.raises(RuntimeError, match="upstream down"):
        cache.get_or_fetch_with_staleness(fail)


def test_concurrent_callers_share_one_fetch():
    cache = TTLCache(10)
    calls = 0
    calls_lock = threading.Lock()
    release = threading.Event()

    def fetch():
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.05)
        release.set()
        return b"value"

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(cache.get_or_fetch_with_staleness, fetch) for _ in range(4)]

    assert [future.result() for future in futures] == [(b"value", False)] * 4
    assert calls == 1
    assert release.is_set()


def test_get_or_fetch_with_staleness_reports_stale_fallback():
    clock = FakeClock()
    cache = TTLCache(10, clock)

    assert cache.get_or_fetch_with_staleness(lambda: b"fresh") == (b"fresh", False)
    clock.advance(60)

    def fail():
        raise RuntimeError("upstream down")

    assert cache.get_or_fetch_with_staleness(fail) == (b"fresh", True)


def test_get_or_fetch_with_staleness_reports_fresh_success():
    cache = TTLCache(10, FakeClock())

    assert cache.get_or_fetch_with_staleness(lambda: b"v1") == (b"v1", False)
    assert cache.get_or_fetch_with_staleness(lambda: b"v2") == (b"v1", False)


def test_legacy_get_or_fetch_is_removed():
    assert not hasattr(TTLCache, "get_or_fetch")
