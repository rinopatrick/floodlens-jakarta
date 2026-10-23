import assert from "node:assert/strict";
import test from "node:test";

import { buildRenderPayload } from "../../public/src/analysis-payload.js";
import { makeScenario } from "./scenario-fixture.js";

test("worker and main thread share one render payload builder", () => {
  const { graph, facilities, baseline, scenario, closed } = makeScenario();
  const payload = buildRenderPayload({
    snap: { coord: [0, 0], distance: 0 },
    baseline,
    scenario,
    closed,
    facilityList: facilities,
    nodes: graph.nodes,
    maxMeters: 5000,
  });

  assert.equal(payload.summary.beforeInRange, 5);
  assert.equal(payload.summary.afterInRange, 3);
  assert.equal(payload.rows.length, 3);
  assert.equal(payload.closedSize, 1);
  assert.ok(payload.baselinePath.length >= 2);
  assert.ok(payload.scenarioPath.length >= 2);
  assert.equal(typeof payload.summary.nearestBaseHospital.name, "string");
});
