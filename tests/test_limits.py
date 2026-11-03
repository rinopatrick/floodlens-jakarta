from floodlens.limits import Cooldown, RateLimiter


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_rate_limiter_rejects_after_limit_and_recovers():
    clock = FakeClock()
    limiter = RateLimiter(2, 10, clock)

    assert limiter.allow("ip")[0] is True
    assert limiter.allow("ip")[0] is True
    allowed, retry = limiter.allow("ip")
    assert allowed is False
    assert retry >= 1

    clock.advance(10)
    assert limiter.allow("ip")[0] is True


def test_cooldown_allows_once_per_window():
    clock = FakeClock()
    cooldown = Cooldown(30, clock)

    assert cooldown.allow("ip")[0] is True
    allowed, retry = cooldown.allow("ip")
    assert allowed is False
    assert retry >= 1

    clock.advance(30)
    assert cooldown.allow("ip")[0] is True


def test_cache_stats_report_presence_and_age():
    from floodlens.cache import TTLCache

    cache = TTLCache(60)
    assert cache.stats()["has_value"] is False
    cache.set("v")
    stats = cache.stats()
    assert stats["has_value"] is True
    assert stats["age_seconds"] is not None
    assert stats["ttl_seconds"] == 60


def test_rate_limiter_reports_remaining_without_consuming():
    clock = FakeClock()
    limiter = RateLimiter(2, 10, clock)

    assert limiter.remaining("ip") == (2, 0)
    assert limiter.allow("ip")[0] is True
    assert limiter.remaining("ip") == (1, 0)
    assert limiter.allow("ip")[0] is True
    remaining, retry = limiter.remaining("ip")
    assert remaining == 0
    assert retry >= 1
