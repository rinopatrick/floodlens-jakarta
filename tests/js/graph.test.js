import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraph,
  dijkstra,
  nearestNode,
  nearestNodeWithDistance,
  restorePath,
} from "../../public/src/graph.js";

const DATA = {
  roads: [
    {
      id: "1",
      name: "Dua arah",
      kind: "primary",
      oneway: "no",
      points: [
        { id: "a", lat: 0, lon: 0 },
        { id: "b", lat: 0, lon: 0.001 },
      ],
    },
    {
      id: "2",
      name: "Satu arah",
      kind: "primary",
      oneway: "yes",
      points: [
        { id: "b", lat: 0, lon: 0.001 },
        { id: "c", lat: 0, lon: 0.002 },
      ],
    },
    {
      id: "3",
      name: "Satu arah balik",
      kind: "primary",
      oneway: "-1",
      points: [
        { id: "c", lat: 0, lon: 0.002 },
        { id: "d", lat: 0, lon: 0.003 },
      ],
    },
  ],
};

test("buildGraph records nodes, segments, and oneway direction", () => {
  const { adjacency, nodes, segments } = buildGraph(DATA);

  assert.equal(nodes.size, 4);
  assert.equal(segments.length, 3);
  assert.equal(adjacency.get("a")[0].to, "b");
  assert.equal(adjacency.get("b").some((edge) => edge.to === "a"), true);
  assert.equal(adjacency.get("b").some((edge) => edge.to === "c"), true);
  assert.equal((adjacency.get("c") || []).some((edge) => edge.to === "b"), false);
  assert.equal(adjacency.get("d").some((edge) => edge.to === "c"), true);
  assert.equal((adjacency.get("c") || []).some((edge) => edge.to === "d"), false);
});

test("dijkstra respects oneway roads and blocked segments", () => {
  const { adjacency, segments } = buildGraph(DATA);

  const baseline = dijkstra(adjacency, "a");
  assert.ok(Math.abs(baseline.distances.get("b") - 111.19) < 0.5);
  assert.ok(Math.abs(baseline.distances.get("c") - 222.39) < 1);
  assert.equal(baseline.distances.has("d"), false);

  const blocked = dijkstra(adjacency, "a", new Set([segments[1].key]));
  assert.equal(blocked.distances.has("c"), false);
  assert.equal(blocked.distances.has("d"), false);
});

test("restorePath returns coordinates from origin to destination", () => {
  const { adjacency, nodes } = buildGraph(DATA);
  const result = dijkstra(adjacency, "a");

  assert.deepEqual(restorePath(nodes, result, "c"), [
    [0, 0],
    [0, 0.001],
    [0, 0.002],
  ]);
  assert.deepEqual(restorePath(nodes, result, "d"), []);
});

test("nearestNode snaps a point to the closest graph node", () => {
  const { nodes } = buildGraph(DATA);

  assert.equal(nearestNode(nodes, { lat: 0, lon: 0.0011 }), "b");
  assert.equal(nearestNode(nodes, { lat: 0, lon: 0.0029 }), "d");
  assert.equal(nearestNode(new Map(), { lat: 0, lon: 0 }), null);
});

test("nearestNodeWithDistance reports the snap distance and coordinate", () => {
  const { nodes } = buildGraph(DATA);
  const match = nearestNodeWithDistance(nodes, { lat: 0, lon: 0.0011 });

  assert.equal(match.nodeId, "b");
  assert.ok(match.distance > 0);
  assert.deepEqual(match.coord, [0, 0.001]);
  assert.equal(nearestNodeWithDistance(new Map(), { lat: 0, lon: 0 }), null);
});
