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

Distances are measured along the mapped street graph, not driving time. The 5 km threshold is a display choice for comparing scenarios, not a clinical or government access standard.

## Run locally

Requires Python 3.10+ and an internet connection. The runtime uses Python's standard library. The browser loads map tiles from Esri; Leaflet, Leaflet.draw, and all fonts are served locally.

```powershell
cd floodlens-jakarta
python server.py
```

Open [http://localhost:8766](http://localhost:8766), select **Muat data live Jakarta**, click the map to choose an origin, and draw a polygon with the map's polygon tool. Press **Hapus zona** to return to the baseline.

The browser never calls Overpass or BNPB directly. It requests `/api/osm` and `/api/flood` from the local server, which handles caching, upstream fallback, and response validation. Basemap tiles are served by Esri World Street Map.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLOODLENS_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in a container. |
| `FLOODLENS_PORT` | `8766` | HTTP port. Falls back to the platform `PORT` variable. |
| `FLOODLENS_ENV` | `development` | Set to `production` to reject fixture mode. |
| `FLOODLENS_FIXTURE_DIR` | unset | Serve deterministic OSM and flood fixtures for tests. |
| `FLOODLENS_TRUST_PROXY` | `0` | Set to `1` only behind a trusted reverse proxy so rate limiting uses `X-Forwarded-For`. |
| `FLOODLENS_CONTACT` | repository URL | Contact URL placed in the Overpass/BNPB `User-Agent`. |

Fixture mode is rejected when `FLOODLENS_ENV=production`. In fixture mode the UI labels the data as contoh, disables the hazard layer, and shows a fixture note in the map legend.

## Tests

Install the development tools once:

```powershell
python -m pip install -r requirements-dev.txt
npm ci
npx playwright install chromium
```

Run every gate:

```powershell
python -m pytest -q
python -m ruff check .
npm test
npx playwright test
```

The Playwright suite starts the server in fixture mode. It never calls live Overpass or BNPB services.

## Deploy

Build and run the container:

```powershell
docker build -t floodlens .
docker run --rm -p 8766:8766 -e FLOODLENS_HOST=0.0.0.0 floodlens
```

The container exposes `GET /healthz` for health checks. `render.yaml` provides the equivalent Render blueprint.

Production notes:

- The cache is in-memory and per process. Run a single instance or add a shared cache before scaling horizontally.
- The server is read-only and stores no user data. It has no authentication. Rate limiting is in-process: 120 API requests per minute per client/path, plus a 30-second refresh cooldown.
- `/api/osm` is gzip-compressed, sends an ETag, and allows a 60-second browser cache with stale-while-revalidate. The server cache remains 15 minutes.
- Analysis, facility snapping, and pathfinding run in a module Web Worker. Graph construction and road drawing remain on the main thread, with a main-thread fallback if the worker cannot start. Very large areas would still benefit from a spatial index.
- Map tiles are provided by Esri World Street Map; for a high-traffic or commercial deployment, use a licensed tile provider or self-hosted tiles. Automated tests must stub tile requests, not hit a public tile server.
- Fonts, Leaflet, and Leaflet.draw are served locally. Only basemap tiles require a third-party provider.
- Live upstream data changes over time. CI uses fixtures; run a manual live smoke test before a release.

## Data and attribution

### Flood-hazard context

The map overlay is rendered from BNPB's [InaRISK flood-hazard MapServer for Jabodetabekpunjur](https://gis.bnpb.go.id/server/rest/services/inarisk/layer_bahaya_banjir_JBTBPJ/MapServer). It is shown as a reference layer; FloodLens does not read its index values as flood depth or as a prediction that a particular road will close. BNPB notes that InaRISK web map information is not suitable for legal or civil-engineering use ([InaRISK WebGIS](https://inarisk.bnpb.go.id/webgis/)).

### Roads and health facilities

The app requests motorway, trunk, primary, secondary, tertiary, residential, and unclassified road ways plus mapped hospital and clinic features from [OpenStreetMap](https://www.openstreetmap.org/) through the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), limited to the Central Jakarta pilot bounding box in the source code. OSM data is licensed under the [Open Database License](https://www.openstreetmap.org/copyright); attribution is shown on the map. Basemap tiles are rendered by Esri World Street Map with HERE, Garmin, and OpenStreetMap contributors; attribution is shown in the legend.

OSM data is community-mapped and can be incomplete or out of date. FloodLens only includes features present in the response for its bounded Jakarta pilot area.

### Vendored libraries

Leaflet 1.9.4 (BSD-2-Clause), Leaflet.draw 1.0.4 (MIT), and the Fraunces / IBM Plex font files (SIL Open Font License 1.1) are vendored under `public/vendor/` with their license files.

## Method

1. Convert each OSM road way into graph edges between its mapped nodes. Use OSM one-way tags when present.
2. Snap the selected origin and each health facility to the nearest mapped road node.
3. Find baseline shortest paths with Dijkstra's algorithm, using road distance as the edge weight.
4. For the scenario, mark each road edge whose midpoint falls inside the user-drawn polygon as closed and run the shortest-path calculation again.
5. Compare reachable health facilities and nearest-hospital distance at the same origin.

The closure is an explicit user assumption. Drawing the polygon over the BNPB layer helps explain the scenario but does not turn the hazard layer into a flood-depth or road-closure dataset.

## Project structure

```text
floodlens-jakarta/
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── src/            # ES modules: app, API, graph, analysis, geo, worker
│   └── vendor/         # Leaflet, Leaflet.draw, and self-hosted fonts with licenses
├── floodlens/
│   ├── config.py       # environment, bounds, CSP, cache TTLs
│   ├── osm.py          # Overpass query, simplification, validation
│   ├── flood.py        # BNPB overlay client
│   └── cache.py        # TTL cache with stale-if-error
├── server.py           # HTTP handler, static serving, health, logs
├── tests/              # pytest, node:test, fixtures
├── e2e/                # Playwright scenario test
├── specs/              # refactor plan and design notes
├── Dockerfile
├── render.yaml
└── .github/workflows/ci.yml
```

## Limitations

- No water depth, flood timing, traffic, travel speeds, turn restrictions, or emergency vehicle rules are modeled.
- Road segments are treated as impassable when their midpoint is inside the drawn polygon. This is a simple stress-test rule, not hydraulic modeling.
- Facilities are snapped to the nearest road node; the result does not model a facility entrance or internal access road.
- A route within 5 km does not guarantee safe or timely access.
- Coverage depends on public service availability and on OpenStreetMap completeness.
- The interface and report strings are in Indonesian; there is no localization layer.

## Portfolio summary

**FloodLens is a geospatial network-analysis project that stress-tests health-facility access under user-defined flood road closures in Central Jakarta.** It integrates public hazard and street data, converts road geometry into a routable graph, and compares shortest-path access before and after a scenario.
