import { readFileSync } from "node:fs";

import { closedSegmentsFor } from "../../public/src/analysis.js";
import {
  buildGraph,
  dijkstra,
  nearestNode,
} from "../../public/src/graph.js";

export const data = JSON.parse(
  readFileSync(new URL("../fixtures/osm_simplified.json", import.meta.url)),
);

export const RING = [
  { lat: -6.1995, lng: 106.8312 },
  { lat: -6.2005, lng: 106.8312 },
  { lat: -6.2005, lng: 106.8318 },
  { lat: -6.1995, lng: 106.8318 },
];

export function makeScenario() {
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
