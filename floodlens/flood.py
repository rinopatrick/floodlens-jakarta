"""BNPB flood-overlay client."""

from __future__ import annotations

from urllib.parse import urlencode
from urllib.request import Request, urlopen

from floodlens.cache import TTLCache
from floodlens.config import EAST, FLOOD_CACHE_TTL, FLOOD_SERVICE, NORTH, SOUTH, WEST

FLOOD_CACHE: TTLCache[bytes] = TTLCache(FLOOD_CACHE_TTL)


def flood_overlay_url() -> str:
    params = urlencode(
        {
            "bbox": f"{WEST - 0.05},{SOUTH - 0.05},{EAST + 0.05},{NORTH + 0.05}",
            "bboxSR": "4326",
            "imageSR": "4326",
            "size": "1440,960",
            "format": "png32",
            "transparent": "true",
            "layers": "show:0",
            "f": "image",
        }
    )
    return f"{FLOOD_SERVICE}/export?{params}"


def fetch_flood_overlay(force_refresh: bool = False) -> bytes:
    return FLOOD_CACHE.get_or_fetch(_fetch_flood_overlay, force_refresh)


def _fetch_flood_overlay() -> bytes:
    request = Request(
        flood_overlay_url(),
        headers={"User-Agent": "FloodLens/0.1 local portfolio demonstration"},
    )
    with urlopen(request, timeout=35) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read()
    if "image/" not in content_type or not body.startswith(b"\x89PNG"):
        raise RuntimeError("BNPB returned an unexpected map image response")
    return body
