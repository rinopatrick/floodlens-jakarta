from pathlib import Path

import pytest

from floodlens.config import load_settings


def test_defaults_bind_to_loopback():
    settings = load_settings({})

    assert settings.host == "127.0.0.1"
    assert settings.port == 8766
    assert settings.environment == "development"
    assert settings.fixture_dir is None


def test_environment_overrides_host_port_and_fixture():
    settings = load_settings(
        {
            "FLOODLENS_HOST": "0.0.0.0",
            "FLOODLENS_PORT": "9000",
            "FLOODLENS_ENV": "staging",
            "FLOODLENS_FIXTURE_DIR": "tests/fixtures",
        }
    )

    assert settings.host == "0.0.0.0"
    assert settings.port == 9000
    assert settings.environment == "staging"
    assert settings.fixture_dir == Path("tests/fixtures")


def test_platform_port_is_used_when_floodlens_port_is_absent():
    settings = load_settings({"PORT": "9001"})

    assert settings.port == 9001


def test_invalid_port_is_rejected():
    with pytest.raises(ValueError, match="integer"):
        load_settings({"FLOODLENS_PORT": "http"})

    with pytest.raises(ValueError, match="between 1 and 65535"):
        load_settings({"FLOODLENS_PORT": "70000"})


def test_fixture_mode_is_rejected_in_production():
    with pytest.raises(ValueError, match="not allowed in production"):
        load_settings(
            {
                "FLOODLENS_ENV": "production",
                "FLOODLENS_FIXTURE_DIR": "tests/fixtures",
            }
        )


def test_fixture_mode_is_allowed_in_development():
    settings = load_settings({"FLOODLENS_FIXTURE_DIR": "tests/fixtures"})

    assert settings.fixture_dir is not None
