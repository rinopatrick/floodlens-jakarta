"""Configuration for the FloodLens demo server."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "public"
APP_VERSION = "0.2.0"
HOST = "127.0.0.1"
PORT = 8766

OVERPASS_ENDPOINTS = (
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
FLOOD_SERVICE = (
    "https://gis.bnpb.go.id/server/rest/services/inarisk/"
    "layer_bahaya_banjir_JBTBPJ/MapServer"
)

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data: blob: https://server.arcgisonline.com; "
    "connect-src 'self'; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
)

# The pilot window keeps the first data pull small enough for a local demo.
SOUTH, WEST, NORTH, EAST = -6.26, 106.78, -6.14, 106.89
PILOT_BOUNDS = {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST}

OSM_CACHE_TTL = 900
FLOOD_CACHE_TTL = 3600


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    environment: str
    fixture_dir: Path | None


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if environ is None else environ
    raw_port = (
        source.get("FLOODLENS_PORT")
        or source.get("PORT")
        or str(PORT)
    )
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError("FLOODLENS_PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise ValueError("FLOODLENS_PORT must be between 1 and 65535")

    environment = source.get("FLOODLENS_ENV", "development")
    raw_fixture = source.get("FLOODLENS_FIXTURE_DIR")
    fixture_dir = Path(raw_fixture).expanduser() if raw_fixture else None
    if environment == "production" and fixture_dir is not None:
        raise ValueError("FLOODLENS_FIXTURE_DIR is not allowed in production")

    return Settings(
        host=source.get("FLOODLENS_HOST", HOST),
        port=port,
        environment=environment,
        fixture_dir=fixture_dir,
    )
