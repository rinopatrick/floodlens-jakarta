"""In-process rate limiting and refresh cooldown helpers."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class RateLimiter:
    def __init__(
        self,
        limit: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> tuple[bool, int]:
        now = self._clock()
        with self._lock:
            hits = [stamp for stamp in self._hits.get(key, []) if now - stamp < self._window]
            if len(hits) >= self._limit:
                self._hits[key] = hits
                retry = max(1, int(self._window - (now - hits[0])))
                return False, retry
            hits.append(now)
            self._hits[key] = hits
            return True, 0

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


class Cooldown:
    def __init__(
        self,
        seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._seconds = seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._last: dict[str, float] = {}

    def allow(self, key: str) -> tuple[bool, int]:
        now = self._clock()
        with self._lock:
            last = self._last.get(key)
            if last is not None and now - last < self._seconds:
                return False, max(1, int(self._seconds - (now - last)))
            self._last[key] = now
            return True, 0

    def clear(self) -> None:
        with self._lock:
            self._last.clear()
