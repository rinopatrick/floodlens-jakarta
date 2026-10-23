import { analyzeScenario, closedSegmentsFor } from "./analysis.js";
import { dijkstra, nearestNodeWithDistance, restorePath } from "./graph.js";

let graph = null;
let facilities = [];
let maxAccessMeters = 5000;

function normalizeNearest(nearest) {
  return nearest
    ? { name: nearest.facility.name, distance: nearest.distance }
    : null;
}

function restore(result, nearest) {
  return nearest
    ? restorePath(graph.nodes, result, nearest.facility.nodeId)
    : [];
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "setup") {
    graph = message.graph;
    facilities = (message.facilities || [])
      .map((facility) => {
        const match = nearestNodeWithDistance(graph.nodes, {
          lat: facility.lat,
          lon: facility.lon,
        });
        return match
          ? {
              ...facility,
              nodeId: match.nodeId,
              snapDistance: match.distance,
            }
          : null;
      })
      .filter(Boolean);
    maxAccessMeters = message.maxAccessMeters ?? 5000;
    self.postMessage({ type: "ready" });
    return;
  }
  if (message.type !== "analyze" || !graph) return;

  const { requestId, origin, ring } = message;
  const snap = nearestNodeWithDistance(graph.nodes, origin);
  if (!snap) {
    self.postMessage({ type: "result", requestId, empty: true });
    return;
  }

  const baseline = dijkstra(graph.adjacency, snap.nodeId);
  const closed = ring ? closedSegmentsFor(graph.segments, ring) : new Set();
  const scenario = dijkstra(graph.adjacency, snap.nodeId, closed);
  const summary = analyzeScenario({
    facilities,
    baseline,
    scenario,
    closed,
    maxAccessMeters,
  });
  const rows = facilities
    .map((facility) => ({
      name: facility.name,
      distance: scenario.distances.get(facility.nodeId),
      snapDistance: facility.snapDistance,
    }))
    .filter((row) => Number.isFinite(row.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  self.postMessage({
    type: "result",
    requestId,
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
      inaccessible: summary.inaccessible,
      nearestBaseHospital: normalizeNearest(summary.nearestBaseHospital),
      nearestScenarioHospital: normalizeNearest(summary.nearestScenarioHospital),
    },
    rows,
    baselinePath: restore(baseline, summary.nearestBaseHospital),
    scenarioPath: restore(scenario, summary.nearestScenarioHospital),
    farSnaps: facilities.filter((facility) => (facility.snapDistance ?? 0) > 500)
      .length,
  });
};
