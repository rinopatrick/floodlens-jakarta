import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyzeScenario,
  closedSegmentsFor,
  nearestFacility,
} from "../../public/src/analysis.js";
import {
  buildGraph,
  dijkstra,
  nearestNode,
} from "../../public/src/graph.js";

const data = JSON.parse(
  readFileSync(new URL("../fixtures/osm_simplified.json", import.meta.url)),
);
const RING = [
  { lat: -6.1995, lng: 106.8312 },
  { lat: -6.2005, lng: 106.8312 },
  { lat: -6.2005, lng: 106.8318 },
  { lat: -6.1995, lng: 106.8318 },
];

function scenarioFor() {
  const graph = buildGraph(data);
  const facilities = data.facilities.map((facility) => ({
    ...facility,
    nodeId: nearestNode(graph.nodes, {
      lat: facility.lat,
      lon: facility.lon,
    }),
  }));
  const start = nearestNode(graph.nodes, { lat: -6.2, lon: 106.83 });
  const baseline = dijkstra(graph.adjacency, start);
  const closed = closedSegmentsFor(graph.segments, RING);
  const scenario = dijkstra(graph.adjacency, start, closed);
  return { graph, facilities, start, baseline, closed, scenario };
}

test("closedSegmentsFor closes only the bridge midpoint", () => {
  const { closed } = scenarioFor();

  assert.deepEqual([...closed], ["102:0"]);
});

test("analyzeScenario reports the expected access loss", () => {
  const { facilities, baseline, scenario, closed } = scenarioFor();
  const summary = analyzeScenario({
    facilities,
    baseline,
    scenario,
    closed,
    maxAccessMeters: 5000,
  });

  assert.equal(summary.beforeInRange, 5);
  assert.equal(summary.afterInRange, 3);
  assert.equal(summary.beforeHospitals, 2);
  assert.equal(summary.afterHospitals, 1);
  assert.equal(summary.beforeClinics, 3);
  assert.equal(summary.afterClinics, 2);
  assert.equal(summary.lost, 2);
  assert.equal(summary.closedCount, 1);
  assert.equal(summary.inaccessible, false);
  assert.ok(
    Math.abs(summary.nearestBaseHospital.distance - 331.7) < 1,
    String(summary.nearestBaseHospital.distance),
  );
  assert.ok(
    Math.abs(summary.nearestScenarioHospital.distance - 556) < 2,
    String(summary.nearestScenarioHospital.distance),
  );
});

test("nearestFacility filters by kind", () => {
  const { facilities, scenario } = scenarioFor();

  assert.equal(
    nearestFacility(facilities, scenario.distances, "hospital").facility.name,
    "RS Utara",
  );
});
