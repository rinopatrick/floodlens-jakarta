import { closedSegmentsFor } from "./analysis.js";
import { dijkstra, nearestNodeWithDistance } from "./graph.js";
import { buildRenderPayload } from "./analysis-payload.js";

let graph = null;
let facilities = [];
let maxAccessMeters = 5000;

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
  self.postMessage({
    type: "result",
    requestId,
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
