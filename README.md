# FloodLens — Central Jakarta Health Access Stress Test

An interactive geospatial scenario tool for asking a practical question: **if a set of Central Jakarta road segments became impassable during a flood, how would road access to nearby health facilities change?**

FloodLens combines a public flood-hazard map with the live OpenStreetMap road network in a bounded Central Jakarta pilot area. Choose a starting point, draw a hypothetical flooded area on the map, and compare the shortest road routes to hospitals and clinics before and after the closure.

> FloodLens is a portfolio analysis and scenario-planning demo. It does not predict flooding, determine actual road closures, or provide emergency routing.

## What it shows

- BNPB's Jabodetabekpunjur flood-hazard layer as geographic context.
- OpenStreetMap roads and mapped hospitals / clinics in the Jakarta pilot area.
- A user-drawn closure polygon for a transparent, repeatable what-if scenario.
- The change in health facilities within a 5 km network-distance radius.
- The nearest hospital route before and after the selected closure.
- The affected road segments and five closest reachable facilities after the scenario.

The app reports distances along the mapped street graph, not driving time. The 5 km threshold is a display choice for comparing scenarios, not a clinical or government access standard.

## Run locally

Requires Python 3.10+ and an internet connection. The server uses Python's standard library; the map loads Leaflet, map tiles, and public data services online.

```powershell
cd floodlens-jabodetabek
python server.py
```

Then open [http://localhost:8766](http://localhost:8766), select **Muat data live Jakarta**, click the map to choose an origin, and draw a polygon with the map's polygon tool. Press **Hapus zona** to return to the baseline.

## Data and attribution

### Flood-hazard context

The map overlay is rendered from BNPB's [InaRISK flood-hazard MapServer for Jabodetabekpunjur](https://gis.bnpb.go.id/server/rest/services/inarisk/layer_bahaya_banjir_JBTBPJ/MapServer). It is shown as a reference layer; FloodLens does not read its index values as flood depth or as a prediction that a particular road will close. BNPB notes that InaRISK web map information is not suitable for legal or civil-engineering use ([InaRISK WebGIS](https://inarisk.bnpb.go.id/webgis/)).

### Roads and health facilities

The app requests motorway, trunk, primary, secondary, tertiary, residential, and unclassified road ways plus mapped hospital and clinic features from [OpenStreetMap](https://www.openstreetmap.org/) through the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), limited to the Central Jakarta pilot bounding box in the source code. OSM data is licensed under the [Open Database License](https://www.openstreetmap.org/copyright); attribution is shown on the map.

OSM data is community-mapped and can be incomplete or out of date. FloodLens only includes features present in the response for its bounded Jakarta pilot area.

## Method

1. Convert each OSM road way into graph edges between its mapped nodes. Use OSM one-way tags when they are present.
2. Snap the selected origin and each health facility to the nearest mapped road node.
3. Find baseline shortest paths with Dijkstra's algorithm, using road distance as the edge weight.
4. For the scenario, mark each road edge whose midpoint falls inside the user-drawn polygon as closed and run the shortest-path calculation again.
5. Compare reachable health facilities and nearest-hospital distance at the same origin.

The closure is an explicit user assumption. Drawing the polygon over the BNPB layer helps explain the scenario but does not turn the hazard layer into a flood-depth or road-closure dataset.

## Limitations

- No water depth, flood timing, traffic, travel speeds, turn restrictions, or emergency vehicle rules are modeled.
- Road segments are treated as impassable when their midpoint is inside the drawn polygon. This is a simple stress-test rule, not hydraulic modeling.
- Facilities are snapped to the nearest road node; the result does not model a facility entrance or internal access road.
- A route within 5 km does not guarantee safe or timely access.
- Coverage depends on public service availability and on OpenStreetMap completeness.

## Project structure

```text
floodlens-jabodetabek/
├── index.html   # Interactive map and client-side graph analysis
├── server.py    # Standard-library local server and public-data proxy
└── README.md
```

## Portfolio summary

**FloodLens is a geospatial network-analysis project that stress-tests health-facility access under user-defined flood road closures in Central Jakarta.** It integrates public hazard and street data, converts road geometry into a routable graph, and compares shortest-path access before and after a scenario.
