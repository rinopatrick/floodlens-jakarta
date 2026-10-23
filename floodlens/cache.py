"""Lock-protected TTL cache with stale-if-error fallback."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class _Entry(Generic[T]):
    stored_at: float
    value: T


class TTLCache(Generic[T]):
    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._entry: _Entry[T] | None = None

    def _fresh(self, entry: _Entry[T] | None) -> bool:
        return entry is not None and self._clock() - entry.stored_at < self._ttl

    def get(self) -> T | None:
        with self._lock:
            if self._fresh(self._entry):
                return self._entry.value
            return None

    def get_stale(self) -> T | None:
        with self._lock:
            return self._entry.value if self._entry else None

    def set(self, value: T) -> None:
        with self._lock:
            self._entry = _Entry(self._clock(), value)

    def clear(self) -> None:
        with self._lock:
            self._entry = None

    def age(self) -> float | None:
        with self._lock:
            if self._entry is None:
                return None
            return max(0.0, self._clock() - self._entry.stored_at)

    def get_or_fetch(
        self, fetch: Callable[[], T], force_refresh: bool = False
    ) -> T:
        if not force_refresh:
            value = self.get()
            if value is not None:
                return value

        # Holding the lock during fetch gives single-flight behaviour: concurrent
        # callers wait for one upstream request instead of stampeding it.
        with self._lock:
            if not force_refresh and self._fresh(self._entry):
                return self._entry.value
            try:
                value = fetch()
            except Exception:
                if self._entry is not None:
                    return self._entry.value
                raise
            self._entry = _Entry(self._clock(), value)
            return value
