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

    assert cache.get_or_fetch(lambda: calls.append(1) or b"value") == b"value"
    assert cache.get_or_fetch(lambda: calls.append(1) or b"other") == b"value"
    assert len(calls) == 1


def test_expired_value_is_fetched_again():
    clock = FakeClock()
    cache = TTLCache(10, clock)
    values = iter([b"old", b"new"])

    assert cache.get_or_fetch(lambda: next(values)) == b"old"
    clock.advance(10)
    assert cache.get_or_fetch(lambda: next(values)) == b"new"


def test_force_refresh_bypasses_fresh_value():
    clock = FakeClock()
    cache = TTLCache(10, clock)
    values = iter([b"old", b"new"])

    assert cache.get_or_fetch(lambda: next(values)) == b"old"
    assert cache.get_or_fetch(lambda: next(values), force_refresh=True) == b"new"
    assert cache.get_stale() == b"new"


def test_stale_value_is_served_when_fetch_fails():
    clock = FakeClock()
    cache = TTLCache(10, clock)

    cache.get_or_fetch(lambda: b"stale")
    clock.advance(60)

    def fail():
        raise RuntimeError("upstream down")

    assert cache.get_or_fetch(fail) == b"stale"


def test_fetch_error_propagates_without_stale_value():
    cache = TTLCache(10, FakeClock())

    def fail():
        raise RuntimeError("upstream down")

    with pytest.raises(RuntimeError, match="upstream down"):
        cache.get_or_fetch(fail)


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
        futures = [pool.submit(cache.get_or_fetch, fetch) for _ in range(4)]

    assert [future.result() for future in futures] == [b"value"] * 4
    assert calls == 1
    assert release.is_set()
