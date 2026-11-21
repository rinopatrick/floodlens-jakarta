import assert from "node:assert/strict";
import test from "node:test";

import { buildRenderPayload } from "../../public/src/analysis-payload.js";
import { makeScenario } from "./scenario-fixture.js";

test("worker and main thread share one render payload builder", () => {
  const { graph, facilities, baseline, scenario, closed, zoneAreaM2 } = makeScenario();
  const payload = buildRenderPayload({
    snap: { coord: [0, 0], distance: 0 },
    baseline,
    scenario,
    closed,
    zoneAreaM2,
    facilityList: facilities,
    nodes: graph.nodes,
    maxMeters: 5000,
  });

  assert.equal(payload.summary.beforeInRange, 5);
  assert.equal(payload.summary.afterInRange, 3);
  assert.equal(payload.rows.length, 3);
  assert.equal(payload.closedSize, 1);
  assert.equal(payload.zoneAreaM2, Math.round(zoneAreaM2));
  assert.ok(payload.baselinePath.length >= 2);
  assert.ok(payload.scenarioPath.length >= 2);
  assert.equal(typeof payload.summary.nearestBaseHospital.name, "string");
});

test("render payload requires an explicit finite zone area", () => {
  const { graph, facilities, baseline, scenario, closed } = makeScenario();
  const options = {
    snap: { coord: [0, 0], distance: 0 },
    baseline, scenario, closed,
    facilityList: facilities, nodes: graph.nodes, maxMeters: 5000,
  };
  assert.throws(() => buildRenderPayload(options), {
    name: "TypeError", message: "zoneAreaM2 must be a finite number",
  });
  for (const zoneAreaM2 of [undefined, null, NaN, Infinity, -Infinity, "7340"]) {
    assert.throws(() => buildRenderPayload({ ...options, zoneAreaM2 }), {
      name: "TypeError", message: "zoneAreaM2 must be a finite number",
    });
  }
});

test("render payload accepts explicit zero area for a null ring", () => {
  const { graph, facilities, baseline } = makeScenario();
  const payload = buildRenderPayload({
    snap: { coord: [0, 0], distance: 0 },
    baseline, scenario: baseline, closed: new Set(), zoneAreaM2: 0,
    facilityList: facilities, nodes: graph.nodes, maxMeters: 5000,
  });
  assert.equal(payload.zoneAreaM2, 0);
  assert.equal(payload.closedSize, 0);
});
