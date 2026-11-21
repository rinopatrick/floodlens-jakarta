"""BNPB flood-overlay client."""

from __future__ import annotations

from urllib.parse import urlencode
from urllib.request import Request, urlopen

from floodlens.cache import TTLCache
from floodlens.config import (
    CONTACT_URL,
    EAST,
    FLOOD_CACHE_TTL,
    FLOOD_SERVICE,
    NORTH,
    SOUTH,
    WEST,
)

FLOOD_CACHE: TTLCache[bytes] = TTLCache(FLOOD_CACHE_TTL)
FLOOD_BOUNDS = {
    "south": SOUTH - 0.05,
    "west": WEST - 0.05,
    "north": NORTH + 0.05,
    "east": EAST + 0.05,
}


def flood_overlay_url() -> str:
    width = FLOOD_BOUNDS["east"] - FLOOD_BOUNDS["west"]
    height = FLOOD_BOUNDS["north"] - FLOOD_BOUNDS["south"]
    scale = 1440 / max(width, height)
    params = urlencode(
        {
            "bbox": ",".join(str(FLOOD_BOUNDS[key]) for key in ("west", "south", "east", "north")),
            "bboxSR": "4326",
            "imageSR": "4326",
            "size": f"{round(width * scale)},{round(height * scale)}",
            "format": "png32",
            "transparent": "true",
            "layers": "show:0",
            "f": "image",
        }
    )
    return f"{FLOOD_SERVICE}/export?{params}"


def fetch_flood_overlay_with_staleness(force_refresh: bool = False) -> tuple[bytes, bool]:
    return FLOOD_CACHE.get_or_fetch_with_staleness(_fetch_flood_overlay, force_refresh)


def _fetch_flood_overlay() -> bytes:
    request = Request(
        flood_overlay_url(),
        headers={"User-Agent": f"FloodLens/0.2 (portfolio demo; +{CONTACT_URL})"},
    )
    with urlopen(request, timeout=35) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read()
    if "image/" not in content_type or not body.startswith(b"\x89PNG"):
        raise RuntimeError("BNPB returned an unexpected map image response")
    return body
