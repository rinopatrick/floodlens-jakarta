"""Local web server and small proxy for public geospatial sources."""

from __future__ import annotations

import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
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

# The pilot window keeps the first data pull small enough for a local demo.
SOUTH, WEST, NORTH, EAST = -6.26, 106.78, -6.14, 106.89
_osm_cache: tuple[float, bytes] | None = None


def overpass_query() -> str:
    bbox = f"{SOUTH},{WEST},{NORTH},{EAST}"
    return f"""[out:json][timeout:60];
(
  way[\"highway\"~\"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$\"]({bbox});
  node[\"amenity\"~\"^(hospital|clinic)$\"]({bbox});
  way[\"amenity\"~\"^(hospital|clinic)$\"]({bbox});
  node[\"healthcare\"~\"^(hospital|clinic|centre)$\"]({bbox});
  way[\"healthcare\"~\"^(hospital|clinic|centre)$\"]({bbox});
);
out body geom;"""


def simplify_osm(payload: dict) -> bytes:
    roads: list[dict] = []
    facilities: list[dict] = []
    seen_facilities: set[tuple[str, str, int, int]] = set()
    allowed_roads = {
        "motorway", "trunk", "primary", "secondary", "tertiary",
        "residential", "unclassified",
    }

    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        amenity = tags.get("amenity", "")
        healthcare = tags.get("healthcare", "")
        if amenity in {"hospital", "clinic"} or healthcare in {
            "hospital", "clinic", "centre"
        }:
            geometry = element.get("geometry") or []
            if element.get("type") == "node":
                lat, lon = element.get("lat"), element.get("lon")
            elif geometry:
                lat = sum(point["lat"] for point in geometry) / len(geometry)
                lon = sum(point["lon"] for point in geometry) / len(geometry)
            else:
                lat = lon = None
            if lat is not None and lon is not None:
                kind = "hospital" if amenity == "hospital" or healthcare == "hospital" else "clinic"
                name = tags.get("name", "Rumah sakit" if kind == "hospital" else "Klinik / puskesmas")
                dedupe_key = (kind, name.casefold(), round(lat * 10_000), round(lon * 10_000))
                if dedupe_key not in seen_facilities:
                    seen_facilities.add(dedupe_key)
                    facilities.append({
                        "id": f"{element.get('type')}/{element.get('id')}",
                        "name": name,
                        "kind": kind,
                        "lat": lat,
                        "lon": lon,
                    })

        highway = tags.get("highway")
        nodes = element.get("nodes") or []
        geometry = element.get("geometry") or []
        if (
            element.get("type") != "way"
            or highway not in allowed_roads
            or len(nodes) < 2
            or len(nodes) != len(geometry)
            or tags.get("access") in {"no", "private"}
            or tags.get("motor_vehicle") in {"no", "private"}
        ):
            continue

        points = [
            {"id": str(node_id), "lat": point["lat"], "lon": point["lon"]}
            for node_id, point in zip(nodes, geometry)
        ]
        roads.append({
            "id": str(element["id"]),
            "name": tags.get("name", ""),
            "kind": highway,
            "oneway": tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no"),
            "points": points,
        })

    return json.dumps({
        "source": "© OpenStreetMap contributors · Overpass API",
        "roads": roads,
        "facilities": facilities,
        "bounds": {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST},
    }, separators=(",", ":")).encode("utf-8")


def fetch_osm(force_refresh: bool = False) -> bytes:
    global _osm_cache
    if not force_refresh and _osm_cache and time.time() - _osm_cache[0] < 900:
        return _osm_cache[1]

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
            simplified = simplify_osm(raw)
            _osm_cache = (time.time(), simplified)
            return simplified
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, KeyError) as exc:
            last_error = exc

    raise RuntimeError(f"OpenStreetMap data could not be fetched: {last_error}")


def fetch_flood_overlay() -> bytes:
    params = urlencode({
        "bbox": f"{WEST - 0.05},{SOUTH - 0.05},{EAST + 0.05},{NORTH + 0.05}",
        "bboxSR": "4326",
        "imageSR": "4326",
        "size": "1440,960",
        "format": "png32",
        "transparent": "true",
        "layers": "show:0",
        "f": "image",
    })
    request = Request(
        f"{FLOOD_SERVICE}/export?{params}",
        headers={"User-Agent": "FloodLens/0.1 local portfolio demonstration"},
    )
    with urlopen(request, timeout=35) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read()
    if "image/" not in content_type or not body.startswith(b"\x89PNG"):
        raise RuntimeError("BNPB returned an unexpected map image response")
    return body


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def send_bytes(self, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 502) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/api/osm":
            try:
                refresh = "refresh=1" in parsed.query
                self.send_bytes(fetch_osm(refresh), "application/json; charset=utf-8")
            except Exception as exc:  # surfaced as a useful local network message
                self.send_error_json(str(exc))
            return
        if parsed.path == "/api/flood":
            try:
                self.send_bytes(fetch_flood_overlay(), "image/png", "public, max-age=3600")
            except Exception as exc:
                self.send_error_json(str(exc))
            return
        super().do_GET()


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FloodLens running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFloodLens stopped.")
    finally:
        server.server_close()
