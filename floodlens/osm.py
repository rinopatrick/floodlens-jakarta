"""Overpass querying, simplification, and validation."""

from __future__ import annotations

import http.client
import json
import math
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from floodlens.cache import TTLCache
from floodlens.config import (
    CONTACT_URL,
    EAST,
    NORTH,
    OSM_CACHE_TTL,
    OVERPASS_ENDPOINTS,
    PILOT_BOUNDS,
    SOUTH,
    WEST,
)

OSM_CACHE: TTLCache[bytes] = TTLCache(OSM_CACHE_TTL)

ALLOWED_ROADS = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "unclassified",
}


def overpass_query() -> str:
    bbox = f"{SOUTH},{WEST},{NORTH},{EAST}"
    return f"""[out:json][timeout:60];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]({bbox});
  node["amenity"~"^(hospital|clinic)$"]({bbox});
  way["amenity"~"^(hospital|clinic)$"]({bbox});
  node["healthcare"~"^(hospital|clinic|centre)$"]({bbox});
  way["healthcare"~"^(hospital|clinic|centre)$"]({bbox});
);
out body geom;"""


def _valid_point(lat: object, lon: object) -> bool:
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    if not math.isfinite(lat) or not math.isfinite(lon):
        return False
    return (
        SOUTH - 0.01 <= lat <= NORTH + 0.01
        and WEST - 0.01 <= lon <= EAST + 0.01
    )


def _as_point(value: object) -> tuple[float, float] | None:
    if not isinstance(value, dict):
        return None
    lat, lon = value.get("lat"), value.get("lon")
    if _valid_point(lat, lon):
        return (lat, lon)
    return None


def _process_facility(
    element: dict,
    facilities: list[dict],
    seen_facilities: set[tuple[str, str, int, int]],
) -> None:
    if not isinstance(element, dict):
        return
    tags = element.get("tags")
    if not isinstance(tags, dict):
        return
    amenity = tags.get("amenity", "")
    healthcare = tags.get("healthcare", "")
    if amenity not in {"hospital", "clinic"} and healthcare not in {
        "hospital",
        "clinic",
        "centre",
    }:
        return
    geometry = element.get("geometry")
    if element.get("type") == "node":
        point = _as_point({"lat": element.get("lat"), "lon": element.get("lon")})
        lat, lon = point if point else (None, None)
    elif isinstance(geometry, list) and geometry:
        valid = [_as_point(p) for p in geometry]
        valid = [p for p in valid if p is not None]
        if not valid:
            return
        lat = sum(p[0] for p in valid) / len(valid)
        lon = sum(p[1] for p in valid) / len(valid)
        if not _valid_point(lat, lon):
            return
    else:
        return
    name = tags.get("name")
    if not isinstance(name, str) or not name:
        kind_probe = (
            "hospital" if amenity == "hospital" or healthcare == "hospital" else "clinic"
        )
        name = "Rumah sakit" if kind_probe == "hospital" else "Klinik / puskesmas"
    kind = "hospital" if amenity == "hospital" or healthcare == "hospital" else "clinic"
    dedupe_key = (kind, name.casefold(), round(lat * 10_000), round(lon * 10_000))
    if dedupe_key in seen_facilities:
        return
    seen_facilities.add(dedupe_key)
    facilities.append(
        {
            "id": f"{element.get('type')}/{element.get('id')}",
            "name": name,
            "kind": kind,
            "lat": lat,
            "lon": lon,
        }
    )


def _process_road(element: dict, roads: list[dict]) -> None:
    if not isinstance(element, dict):
        return
    tags = element.get("tags")
    if not isinstance(tags, dict):
        return
    highway = tags.get("highway")
    nodes = element.get("nodes")
    geometry = element.get("geometry")
    if (
        element.get("type") != "way"
        or highway not in ALLOWED_ROADS
        or not isinstance(nodes, list)
        or not isinstance(geometry, list)
        or len(nodes) < 2
        or len(nodes) != len(geometry)
        or tags.get("access") in {"no", "private"}
        or tags.get("motor_vehicle") in {"no", "private"}
    ):
        return
    # shortcut: a node/geometry length mismatch means the way shape is
    # untrustworthy; skip it instead of failing the whole payload.
    points = []
    for node_id, point in zip(nodes, geometry, strict=True):
        coords = _as_point(point)
        if coords is None:
            continue
        points.append({"id": str(node_id), "lat": coords[0], "lon": coords[1]})
    if len(points) < 2:
        return
    roads.append(
        {
            "id": str(element.get("id")),
            "name": tags.get("name", "") if isinstance(tags.get("name", ""), str) else "",
            "kind": highway,
            "oneway": tags.get(
                "oneway", "yes" if tags.get("junction") == "roundabout" else "no"
            ),
            "points": points,
        }
    )


def simplify_osm(payload: dict) -> bytes:
    roads: list[dict] = []
    facilities: list[dict] = []
    seen_facilities: set[tuple[str, str, int, int]] = set()

    elements = payload.get("elements") if isinstance(payload, dict) else []
    if not isinstance(elements, list):
        elements = []
    for element in elements:
        # One malformed element must not poison the whole payload.
        try:
            _process_facility(element, facilities, seen_facilities)
            _process_road(element, roads)
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue

    osm3s = payload.get("osm3s") if isinstance(payload, dict) else None
    timestamp = osm3s.get("timestamp_osm_base", "") if isinstance(osm3s, dict) else ""
    return json.dumps(
        {
            "schemaVersion": 1,
            "source": "© OpenStreetMap contributors · Overpass API",
            "dataTimestamp": str(timestamp),
            "roads": roads,
            "facilities": facilities,
            "bounds": PILOT_BOUNDS,
        },
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def fetch_osm(force_refresh: bool = False) -> bytes:
    return OSM_CACHE.get_or_fetch(_fetch_osm_from_upstream, force_refresh)


def _fetch_osm_from_upstream() -> bytes:
    body = urlencode({"data": overpass_query()}).encode("utf-8")
    last_error: Exception | None = None
    for index, endpoint in enumerate(OVERPASS_ENDPOINTS):
        request = Request(
            endpoint,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": f"FloodLens/0.2 (portfolio demo; +{CONTACT_URL})",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=75) as response:
                raw = json.loads(response.read())
            return simplify_osm(raw)
        except (
            HTTPError,
            URLError,
            http.client.HTTPException,
            TimeoutError,
            OSError,
            json.JSONDecodeError,
            KeyError,
        ) as exc:
            last_error = exc
            if endpoint != OVERPASS_ENDPOINTS[-1]:
                time.sleep(min(2, 0.5 * (index + 1)))

    raise RuntimeError(f"OpenStreetMap data could not be fetched: {last_error}")
