import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { buildSpatialIndex, nearestNodeWithDistance } from "../public/src/graph.js";

let seed = 42;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

function randomPoint() {
  return { lat: -6.35 + random() * 0.27, lon: 106.68 + random() * 0.30 };
}

const nodes = new Map(Array.from({ length: 60_000 }, (_, id) => {
  const { lat, lon } = randomPoint();
  return [id, [lat, lon]];
}));
const facilities = Array.from({ length: 600 }, randomPoint);
const buildStart = performance.now();
const index = buildSpatialIndex(nodes);
const buildMs = performance.now() - buildStart;

function snap(points, spatialIndex) {
  return points.map((point) => nearestNodeWithDistance(nodes, point, spatialIndex));
}

const warmup = facilities.slice(0, 30);
snap(warmup, null);
snap(warmup, index);

function measure(spatialIndex, times) {
  const start = performance.now();
  const results = snap(facilities, spatialIndex);
  times.push(performance.now() - start);
  return results;
}

const linearTimes = [];
const indexedTimes = [];
for (let i = 0; i < 3; i++) {
  const linear = measure(null, linearTimes);
  const indexed = measure(index, indexedTimes);
  assert.deepEqual(indexed, linear);
}

function median(times) {
  return times.sort((a, b) => a - b)[1];
}

const linearMs = median(linearTimes);
const indexedMs = median(indexedTimes);
console.log(`${nodes.size} nodes × ${facilities.length} facilities (median of 3, exact matches)`);
console.log(`Linear: ${linearMs.toFixed(1)} ms; indexed: ${indexedMs.toFixed(1)} ms; build: ${buildMs.toFixed(1)} ms`);
console.log(`Speedup including build: ${(linearMs / (indexedMs + buildMs)).toFixed(1)}×`);
