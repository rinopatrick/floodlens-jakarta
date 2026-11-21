import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  buildGraph,
  buildSpatialIndex,
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

function osmWay(id, nodes, latitudes) {
  return {
    type: "way",
    id,
    tags: { highway: "primary" },
    nodes,
    geometry: latitudes.map((lat, index) => ({ lat, lon: 106.83 + index / 1000 })),
  };
}

function graphFromOsmWays(...ways) {
  const args = [
    "-c",
    "import json, sys; from floodlens.osm import simplify_osm; " +
      "sys.stdout.buffer.write(simplify_osm(json.load(sys.stdin)))",
  ];
  const options = {
    cwd: new URL("../../", import.meta.url),
    input: JSON.stringify({ elements: ways }),
    encoding: "utf8",
  };
  let output;
  try {
    output = execFileSync("python", args, options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    output = execFileSync("python3", args, options);
  }
  return buildGraph(JSON.parse(output));
}

test("buildGraph does not bridge invalid intermediate OSM geometry", () => {
  const { segments } = graphFromOsmWays(osmWay(9, [1, 2, 3], [-6.2, null, -6.2]));

  assert.deepEqual(segments.map(({ from, to }) => [from, to]), []);
});

test("blocking one split road segment leaves the other open", () => {
  const { adjacency, segments } = graphFromOsmWays(
    osmWay(9, [1, 2, 3, 4, 5], [-6.2, -6.2, -6.4, -6.2, -6.2]),
  );

  assert.deepEqual(segments.map(({ from, to }) => [from, to]), [["1", "2"], ["4", "5"]]);
  const blocked = new Set([segments[0].key]);
  assert.equal(dijkstra(adjacency, "1", blocked).distances.has("2"), false);
  assert.equal(dijkstra(adjacency, "4", blocked).distances.has("5"), true);
});

test("malformed way IDs cannot share a split road's closure key", () => {
  const { adjacency, segments } = graphFromOsmWays(
    osmWay(9, [1, 2, 3, 4, 5], [-6.2, -6.2, null, -6.2, -6.2]),
    osmWay(9.1, [6, 7], [-6.2, -6.2]),
    osmWay(10, [8, 9], [-6.2, -6.2]),
  );

  assert.equal(new Set(segments.map(({ key }) => key)).size, segments.length);
  assert.deepEqual(segments.map(({ from, to }) => [from, to]), [
    ["1", "2"], ["4", "5"], ["8", "9"],
  ]);
  const blocked = new Set([segments[1].key]);
  assert.equal(dijkstra(adjacency, "4", blocked).distances.has("5"), false);
  assert.equal(dijkstra(adjacency, "8", blocked).distances.has("9"), true);
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

test("spatial index matches linear snap", () => {
  const { nodes } = buildGraph(DATA);
  const index = buildSpatialIndex(nodes, 0.001);
  const point = { lat: 0, lon: 0.0011 };
  const indexed = nearestNodeWithDistance(nodes, point, index);
  const linear = nearestNodeWithDistance(nodes, point);

  assert.equal(indexed.nodeId, linear.nodeId);
  assert.ok(Math.abs(indexed.distance - linear.distance) < 1e-6);
});
