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
