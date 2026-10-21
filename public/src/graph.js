import { distanceMeters } from "./geo.js";

function addAdjacency(adjacency, from, to, edge) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push({
    to,
    weight: edge.weight,
    key: edge.key,
    segment: edge,
  });
}

export function buildGraph(data) {
  const adjacency = new Map();
  const nodes = new Map();
  const segments = [];
  for (const road of data.roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      if (!a.id || !b.id || a.id === b.id) continue;
      nodes.set(a.id, [a.lat, a.lon]);
      nodes.set(b.id, [b.lat, b.lon]);
      const edge = {
        key: `${road.id}:${i}`,
        from: a.id,
        to: b.id,
        weight: distanceMeters(a, b),
        a: [a.lat, a.lon],
        b: [b.lat, b.lon],
        name: road.name,
        kind: road.kind,
      };
      segments.push(edge);
      if (road.oneway === "-1") addAdjacency(adjacency, b.id, a.id, edge);
      else {
        addAdjacency(adjacency, a.id, b.id, edge);
        if (!["yes", "1", "true"].includes(String(road.oneway).toLowerCase())) {
          addAdjacency(adjacency, b.id, a.id, edge);
        }
      }
    }
  }
  return { adjacency, nodes, segments };
}

export function nearestNode(nodes, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const [nodeId, candidate] of nodes) {
    const d = distanceMeters(point, { lat: candidate[0], lon: candidate[1] });
    if (d < bestDistance) {
      bestDistance = d;
      best = nodeId;
    }
  }
  return best;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.items[p].distance <= item.distance) break;
      this.items[i] = this.items[p];
      i = p;
    }
    this.items[i] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child =
          right < this.items.length &&
          this.items[right].distance < this.items[left].distance
            ? right
            : left;
        if (this.items[child].distance >= last.distance) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }

  get size() {
    return this.items.length;
  }
}

export function dijkstra(adjacency, start, blocked = new Set()) {
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ node: start, distance: 0 });
  while (heap.size) {
    const current = heap.pop();
    if (current.distance !== distances.get(current.node)) continue;
    for (const edge of adjacency.get(current.node) || []) {
      if (blocked.has(edge.key)) continue;
      const nextDistance = current.distance + edge.weight;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, { node: current.node, segment: edge.segment });
        heap.push({ node: edge.to, distance: nextDistance });
      }
    }
  }
  return { distances, previous };
}

export function restorePath(nodes, result, end) {
  if (!result.distances.has(end)) return [];
  const coords = [];
  let node = end;
  while (node) {
    const coordinate = nodes.get(node);
    if (coordinate) coords.push(coordinate);
    const previous = result.previous.get(node);
    if (!previous) break;
    node = previous.node;
  }
  return coords.reverse();
}
