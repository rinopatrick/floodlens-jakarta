import assert from "node:assert/strict";
import test from "node:test";

import { buildRenderPayload } from "../../public/src/analysis-payload.js";
import { buildGraph, buildSpatialIndex, nearestNodeWithDistance } from "../../public/src/graph.js";
import { data, makeScenario, RING } from "./scenario-fixture.js";

const origin = { lat: -6.2, lon: 106.83 };
let workerId = 0;

async function createWorker(graph = buildGraph(data)) {
  const replies = [];
  const previousSelf = globalThis.self;
  const scope = { postMessage: (message) => replies.push(structuredClone(message)) };
  globalThis.self = scope;
  try {
    await import(`../../public/src/analysis-worker.js?test=${workerId++}`);
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
  const send = (message) => {
    globalThis.self = scope;
    try {
      scope.onmessage({ data: structuredClone(message) });
    } finally {
      if (previousSelf === undefined) delete globalThis.self;
      else globalThis.self = previousSelf;
    }
    return replies.shift();
  };
  assert.deepEqual(send({ type: "setup", graph, facilities: data.facilities }), { type: "ready" });
  return send;
}

test("worker protocol returns rounded polygon area matching the main-thread fallback", async () => {
  const send = await createWorker();
  const result = send({ type: "analyze", requestId: 1, origin, ring: RING });
  assert.equal(result.type, "result");
  assert.equal(result.requestId, 1);
  // Fixture polygon area: 7340.010107502245 m².
  assert.equal(result.zoneAreaM2, 7340);

  const { graph, baseline, scenario, closed, zoneAreaM2 } = makeScenario();
  const spatialIndex = buildSpatialIndex(graph.nodes);
  const facilities = data.facilities.map((facility) => {
    const match = nearestNodeWithDistance(graph.nodes, facility, spatialIndex);
    return match
      ? { ...facility, nodeId: match.nodeId, snapDistance: match.distance }
      : null;
  }).filter(Boolean);
  const fallback = buildRenderPayload({
    snap: nearestNodeWithDistance(graph.nodes, origin, spatialIndex),
    baseline, scenario, closed, zoneAreaM2,
    facilityList: facilities, nodes: graph.nodes, maxMeters: 5000,
  });
  const { type, requestId, ...payload } = result;
  assert.deepEqual(payload, fallback);
});

test("worker protocol resets area for null rings across repeated analysis messages", async () => {
  const send = await createWorker();
  for (const [index, ring] of [null, RING, null, RING].entries()) {
    const result = send({ type: "analyze", requestId: index, origin, ring });
    assert.equal(result.requestId, index);
    assert.equal(result.zoneAreaM2, ring ? 7340 : 0);
    assert.equal(result.closedSize, ring ? 1 : 0);
  }
});

test("worker protocol reports an empty graph without a render payload", async () => {
  const send = await createWorker(buildGraph({ roads: [] }));
  for (const [requestId, ring] of [RING, null].entries()) {
    assert.deepEqual(send({ type: "analyze", requestId, origin, ring }), {
      type: "result", requestId, empty: true,
    });
  }
});
