import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { analyzeScenario, nearestFacility } from "../../public/src/analysis.js";
import { restorePath } from "../../public/src/graph.js";
import { makeScenario } from "./scenario-fixture.js";

const golden = JSON.parse(
  readFileSync(new URL("../fixtures/analysis_golden.json", import.meta.url)),
);

function assertDistances(actual, expected) {
  assert.equal(actual.size, Object.keys(expected).length);
  for (const [node, distance] of Object.entries(expected)) {
    assert.ok(
      Math.abs(actual.get(node) - distance) < 1e-6,
      `${node}: ${actual.get(node)} != ${distance}`,
    );
  }
}

test("fixed scenario matches the committed analysis golden", () => {
  const { graph, facilities, start, baseline, closed, scenario } =
    makeScenario();

  assert.equal(start, golden.start);
  assert.deepEqual([...closed], golden.closed);
  assertDistances(baseline.distances, golden.baselineDistances);
  assertDistances(scenario.distances, golden.scenarioDistances);

  const summary = analyzeScenario({
    facilities,
    baseline,
    scenario,
    closed,
    maxAccessMeters: 5000,
  });
  const nearestBaseHospital = nearestFacility(
    facilities,
    baseline.distances,
    "hospital",
  );
  const nearestScenarioHospital = nearestFacility(
    facilities,
    scenario.distances,
    "hospital",
  );

  assert.equal(summary.beforeInRange, golden.summary.beforeInRange);
  assert.equal(summary.afterInRange, golden.summary.afterInRange);
  assert.equal(summary.beforeHospitals, golden.summary.beforeHospitals);
  assert.equal(summary.beforeClinics, golden.summary.beforeClinics);
  assert.equal(summary.afterHospitals, golden.summary.afterHospitals);
  assert.equal(summary.afterClinics, golden.summary.afterClinics);
  assert.equal(summary.lost, golden.summary.lost);
  assert.equal(summary.closedCount, golden.summary.closedCount);
  assert.equal(summary.inaccessible, golden.summary.inaccessible);
  assert.equal(
    nearestBaseHospital.facility.name,
    golden.summary.nearestBaseHospital.name,
  );
  assert.ok(
    Math.abs(
      nearestBaseHospital.distance -
        golden.summary.nearestBaseHospital.distance,
    ) < 1e-6,
  );
  assert.equal(
    nearestScenarioHospital.facility.name,
    golden.summary.nearestScenarioHospital.name,
  );
  assert.ok(
    Math.abs(
      nearestScenarioHospital.distance -
        golden.summary.nearestScenarioHospital.distance,
    ) < 1e-6,
  );

  assert.deepEqual(
    restorePath(graph.nodes, baseline, nearestBaseHospital.facility.nodeId),
    golden.routes.baseline,
  );
  assert.deepEqual(
    restorePath(
      graph.nodes,
      scenario,
      nearestScenarioHospital.facility.nodeId,
    ),
    golden.routes.scenario,
  );
});
