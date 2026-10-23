"""In-process rate limiting and refresh cooldown helpers."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class RateLimiter:
    MAX_KEYS = 4096

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
            self._evict(now)
            hits = [stamp for stamp in self._hits.get(key, []) if now - stamp < self._window]
            if len(hits) >= self._limit:
                self._hits[key] = hits
                retry = max(1, int(self._window - (now - hits[0])))
                return False, retry
            hits.append(now)
            self._hits[key] = hits
            return True, 0

    def _evict(self, now: float) -> None:
        # shortcut: drop idle client keys so the map cannot grow forever.
        stale = [
            key
            for key, hits in self._hits.items()
            if not hits or now - hits[-1] >= self._window
        ]
        for key in stale:
            del self._hits[key]
        while len(self._hits) >= self.MAX_KEYS:
            self._hits.pop(next(iter(self._hits)))

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


class Cooldown:
    MAX_KEYS = 4096

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
            if len(self._last) > self.MAX_KEYS:
                cutoff = now - self._seconds
                stale = [k for k, v in self._last.items() if v < cutoff and k != key]
                for k in stale:
                    del self._last[k]
                while len(self._last) > self.MAX_KEYS:
                    oldest = min(self._last, key=self._last.get)
                    if oldest == key:
                        break
                    del self._last[oldest]
            return True, 0

    def clear(self) -> None:
        with self._lock:
            self._last.clear()
