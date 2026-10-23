import json
from pathlib import Path

from floodlens.osm import overpass_query, simplify_osm

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "overpass_synthetic.json").read_text(encoding="utf-8")
)


def simplified():
    return json.loads(simplify_osm(FIXTURE))


def test_query_covers_pilot_bbox_and_road_classes():
    query = overpass_query()
    assert "-6.26,106.78,-6.14,106.89" in query
    assert "motorway|trunk|primary|secondary|tertiary|residential|unclassified" in query
    assert 'amenity"~"^(hospital|clinic)$' in query
    assert "out body geom;" in query


def test_roads_keep_only_motor_vehicle_ways():
    roads = simplified()["roads"]
    ids = {road["id"] for road in roads}

    assert ids == {str(way_id) for way_id in (101, 102, 103, 104, 105, 106, 107, 108, 114, 115)}
    assert len(roads) == 10
    assert all(len(road["points"]) >= 2 for road in roads)


def test_roads_preserve_oneway_and_names():
    roads = {road["id"]: road for road in simplified()["roads"]}

    assert roads["101"]["oneway"] == "no"
    assert roads["105"]["oneway"] == "yes"
    assert roads["115"]["oneway"] == "-1"
    assert roads["102"]["name"] == "Jembatan"
    assert roads["101"]["points"][0]["id"] == "1"


def test_facilities_are_deduped_and_classified():
    facilities = simplified()["facilities"]
    by_name = {facility["name"]: facility for facility in facilities}

    assert len(facilities) == 5
    assert by_name["RS Jembatan"]["kind"] == "hospital"
    assert by_name["RS Utara"]["kind"] == "hospital"
    assert by_name["Klinik Selatan"]["kind"] == "clinic"
    assert by_name["Klinik Timur"]["kind"] == "clinic"
    assert by_name["Klinik / puskesmas"]["kind"] == "clinic"
    assert "way/210" not in {facility["id"] for facility in facilities}


def test_payload_is_valid_json_with_expected_metadata():
    payload = simplified()

    assert payload["schemaVersion"] == 1
    assert payload["dataTimestamp"] == "2026-10-21T00:00:00Z"
    assert payload["bounds"] == {
        "south": -6.26,
        "west": 106.78,
        "north": -6.14,
        "east": 106.89,
    }
    assert payload["source"].startswith("© OpenStreetMap contributors")
    assert json.dumps(payload, allow_nan=False)


def test_malformed_way_does_not_poison_payload():
    broken = {
        "osm3s": {},
        "elements": [
            {"type": "node", "id": 1, "lat": -6.2, "lon": 106.83},
            {
                "type": "way",
                "id": 999,
                "nodes": [1, 2, 3],  # length mismatch on purpose
                "geometry": [{"lat": -6.2, "lon": 106.83}],
                "tags": {"highway": "primary"},
            },
            {"type": "node", "id": 2, "lat": None, "lon": 106.83},  # bad point
            {"type": "way", "id": 1000},  # missing fields entirely
            {
                "type": "way",
                "id": 1001,
                "nodes": [10, 11],
                "geometry": [
                    {"lat": -6.2, "lon": 106.83},
                    {"lat": -6.199, "lon": 106.83},
                ],
                "tags": {"highway": "primary"},
            },
        ],
    }
    payload = json.loads(simplify_osm(broken))
    assert [road["id"] for road in payload["roads"]] == ["1001"]


def test_malformed_facility_points_are_skipped():
    broken = {
        "osm3s": {},
        "elements": [
            {"type": "node", "id": 1, "lat": -6.2},  # missing lon
            {
                "type": "way",
                "id": 50,
                "tags": {"amenity": "hospital", "name": "RS Bagus"},
                "geometry": [
                    {"lat": -6.2, "lon": 106.83},
                    {"lon": 106.84},  # missing lat: tolerated
                ],
            },
        ],
    }
    payload = json.loads(simplify_osm(broken))
    assert len(payload["facilities"]) == 1
    assert payload["facilities"][0]["name"] == "RS Bagus"
