import { closedSegmentsFor } from "./analysis.js";
import { buildSpatialIndex, dijkstra, nearestNodeWithDistance } from "./graph.js";
import { buildRenderPayload } from "./analysis-payload.js";

let graph = null;
let spatialIndex = null;
let facilities = [];
let maxAccessMeters = 5000;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "setup") {
    graph = message.graph;
    spatialIndex = buildSpatialIndex(graph.nodes);
    facilities = (message.facilities || [])
      .map((facility) => {
        const match = nearestNodeWithDistance(graph.nodes, {
          lat: facility.lat,
          lon: facility.lon,
        }, spatialIndex);
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
  const snap = nearestNodeWithDistance(graph.nodes, origin, spatialIndex);
  if (!snap) {
    self.postMessage({ type: "result", requestId, empty: true });
    return;
  }

  const baseline = dijkstra(graph.adjacency, snap.nodeId);
  const { closed, zoneAreaM2 } = ring
    ? closedSegmentsFor(graph.segments, ring)
    : { closed: new Set(), zoneAreaM2: 0 };
  const scenario = dijkstra(graph.adjacency, snap.nodeId, closed);
  self.postMessage({
    type: "result",
    requestId,
    zoneAreaM2,
    ...buildRenderPayload({
      snap,
      baseline,
      scenario,
      closed,
      facilityList: facilities,
      nodes: graph.nodes,
      maxMeters: maxAccessMeters,
    }),
  });
};
