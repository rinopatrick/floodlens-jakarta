import { pointInPolygon } from "./geo.js";

export function closedSegmentsFor(segments, ring) {
  const closed = new Set();
  if (!ring || ring.length < 3) return closed;
  for (const segment of segments) {
    const midpoint = [
      (segment.a[0] + segment.b[0]) / 2,
      (segment.a[1] + segment.b[1]) / 2,
    ];
    if (pointInPolygon(midpoint, ring)) closed.add(segment.key);
  }
  return closed;
}

export function nearestFacility(facilities, distances, kind = null) {
  let best = null;
  for (const facility of facilities) {
    if (kind && facility.kind !== kind) continue;
    const distance = distances.get(facility.nodeId);
    if (distance === undefined) continue;
    if (!best || distance < best.distance) best = { facility, distance };
  }
  return best;
}

function countInRange(facilities, distances, maxAccessMeters, kind = null) {
  return facilities.filter(
    (facility) =>
      (!kind || facility.kind === kind) &&
      (distances.get(facility.nodeId) ?? Infinity) <= maxAccessMeters,
  ).length;
}

export function analyzeScenario({
  facilities,
  baseline,
  scenario,
  closed,
  maxAccessMeters,
}) {
  const beforeInRange = countInRange(
    facilities,
    baseline.distances,
    maxAccessMeters,
  );
  const afterInRange = countInRange(
    facilities,
    scenario.distances,
    maxAccessMeters,
  );
  const nearestBase = nearestFacility(facilities, baseline.distances);
  const nearestScenario = nearestFacility(facilities, scenario.distances);

  return {
    beforeInRange,
    afterInRange,
    beforeHospitals: countInRange(
      facilities,
      baseline.distances,
      maxAccessMeters,
      "hospital",
    ),
    beforeClinics: countInRange(
      facilities,
      baseline.distances,
      maxAccessMeters,
      "clinic",
    ),
    afterHospitals: countInRange(
      facilities,
      scenario.distances,
      maxAccessMeters,
      "hospital",
    ),
    afterClinics: countInRange(
      facilities,
      scenario.distances,
      maxAccessMeters,
      "clinic",
    ),
    nearestBaseHospital: nearestFacility(
      facilities,
      baseline.distances,
      "hospital",
    ),
    nearestScenarioHospital: nearestFacility(
      facilities,
      scenario.distances,
      "hospital",
    ),
    lost: Math.max(0, beforeInRange - afterInRange),
    closedCount: closed.size,
    inaccessible: Boolean(nearestBase && !nearestScenario),
  };
}
