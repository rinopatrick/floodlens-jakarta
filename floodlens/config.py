"""Configuration for the FloodLens demo server."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
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
PILOT_BOUNDS = {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST}
