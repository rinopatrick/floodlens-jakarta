"""Overpass querying, simplification, and validation."""

from __future__ import annotations

import json
import math
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from floodlens.cache import TTLCache
from floodlens.config import (
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


def simplify_osm(payload: dict) -> bytes:
    roads: list[dict] = []
    facilities: list[dict] = []
    seen_facilities: set[tuple[str, str, int, int]] = set()

    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        amenity = tags.get("amenity", "")
        healthcare = tags.get("healthcare", "")
        if amenity in {"hospital", "clinic"} or healthcare in {
            "hospital",
            "clinic",
            "centre",
        }:
            geometry = element.get("geometry") or []
            if element.get("type") == "node":
                lat, lon = element.get("lat"), element.get("lon")
            elif geometry:
                lat = sum(point["lat"] for point in geometry) / len(geometry)
                lon = sum(point["lon"] for point in geometry) / len(geometry)
            else:
                lat = lon = None
            if _valid_point(lat, lon):
                kind = (
                    "hospital"
                    if amenity == "hospital" or healthcare == "hospital"
                    else "clinic"
                )
                name = tags.get(
                    "name",
                    "Rumah sakit" if kind == "hospital" else "Klinik / puskesmas",
                )
                dedupe_key = (
                    kind,
                    name.casefold(),
                    round(lat * 10_000),
                    round(lon * 10_000),
                )
                if dedupe_key not in seen_facilities:
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

        highway = tags.get("highway")
        nodes = element.get("nodes") or []
        geometry = element.get("geometry") or []
        if (
            element.get("type") != "way"
            or highway not in ALLOWED_ROADS
            or len(nodes) < 2
            or len(nodes) != len(geometry)
            or tags.get("access") in {"no", "private"}
            or tags.get("motor_vehicle") in {"no", "private"}
        ):
            continue

        points = [
            {"id": str(node_id), "lat": point["lat"], "lon": point["lon"]}
            for node_id, point in zip(nodes, geometry, strict=True)
            if _valid_point(point.get("lat"), point.get("lon"))
        ]
        if len(points) < 2:
            continue

        roads.append(
            {
                "id": str(element["id"]),
                "name": tags.get("name", ""),
                "kind": highway,
                "oneway": tags.get(
                    "oneway", "yes" if tags.get("junction") == "roundabout" else "no"
                ),
                "points": points,
            }
        )

    return json.dumps(
        {
            "schemaVersion": 1,
            "source": "© OpenStreetMap contributors · Overpass API",
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
    for endpoint in OVERPASS_ENDPOINTS:
        request = Request(
            endpoint,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "FloodLens/0.1 local portfolio demonstration",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=75) as response:
                raw = json.loads(response.read())
            return simplify_osm(raw)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, KeyError) as exc:
            last_error = exc

    raise RuntimeError(f"OpenStreetMap data could not be fetched: {last_error}")
