import { analyzeScenario } from "./analysis.js";
import { restorePath } from "./graph.js";

// One render-payload builder for the Worker path and the main-thread
// fallback. Pure: no Leaflet, no DOM, unit-tested.
export function buildRenderPayload({ snap, baseline, scenario, closed, facilityList, nodes, maxMeters }) {
  const summary = analyzeScenario({
    facilities: facilityList,
    baseline,
    scenario,
    closed,
    maxAccessMeters: maxMeters,
  });
  const base = summary.nearestBaseHospital;
  const scen = summary.nearestScenarioHospital;
  return {
    snap: {
      lat: snap.coord[0],
      lon: snap.coord[1],
      distance: snap.distance,
    },
    closed: [...closed],
    closedSize: closed.size,
    summary: {
      beforeInRange: summary.beforeInRange,
      afterInRange: summary.afterInRange,
      beforeHospitals: summary.beforeHospitals,
      beforeClinics: summary.beforeClinics,
      afterHospitals: summary.afterHospitals,
      afterClinics: summary.afterClinics,
      lost: summary.lost,
      closedCount: summary.closedCount,
      inaccessible: summary.inaccessible,
      nearestBaseHospital: base
        ? { name: base.facility.name, distance: base.distance }
        : null,
      nearestScenarioHospital: scen
        ? { name: scen.facility.name, distance: scen.distance }
        : null,
    },
    rows: facilityList
      .map((facility) => ({
        name: facility.name,
        distance: scenario.distances.get(facility.nodeId),
        snapDistance: facility.snapDistance,
      }))
      .filter((row) => Number.isFinite(row.distance))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5),
    baselinePath: base ? restorePath(nodes, baseline, base.facility.nodeId) : [],
    scenarioPath: scen ? restorePath(nodes, scenario, scen.facility.nodeId) : [],
    farSnaps: facilityList.filter((facility) => (facility.snapDistance ?? 0) > 500).length,
  };
}
