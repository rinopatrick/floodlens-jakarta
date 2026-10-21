import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeScenario,
  nearestFacility,
} from "../../public/src/analysis.js";
import { makeScenario } from "./scenario-fixture.js";

test("closedSegmentsFor closes only the bridge midpoint", () => {
  const { closed } = makeScenario();

  assert.deepEqual([...closed], ["102:0"]);
});

test("analyzeScenario reports the expected access loss", () => {
  const { facilities, baseline, scenario, closed } = makeScenario();
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
  const { facilities, scenario } = makeScenario();

  assert.equal(
    nearestFacility(facilities, scenario.distances, "hospital").facility.name,
    "RS Utara",
  );
});
