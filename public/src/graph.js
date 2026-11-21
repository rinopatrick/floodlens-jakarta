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

export function buildSpatialIndex(nodes, cellDegrees = 0.01) {
  const cells = new Map();
  const order = new Map();
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const [nodeId, [lat, lon]] of nodes) {
    const cell = `${Math.floor(lat / cellDegrees)}:${Math.floor(lon / cellDegrees)}`;
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(nodeId);
    order.set(nodeId, order.size);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  return { nodes, cells, cellDegrees, order, bounds: { south, north, west, east } };
}

const CELL_EDGE_PADDING = 1e-9;

function distanceOutsideCells(point, baseLat, baseLon, ring, cellDegrees, maxAbsLat) {
  const latGap = Math.max(0, Math.min(
    point.lat - (baseLat - ring) * cellDegrees,
    (baseLat + ring + 1) * cellDegrees - point.lat,
  ) - CELL_EDGE_PADDING);
  const lonGap = Math.max(0, Math.min(
    point.lon - (baseLon - ring) * cellDegrees,
    (baseLon + ring + 1) * cellDegrees - point.lon,
  ) - CELL_EDGE_PADDING);

  // Either latitude or longitude is outside. Drop the other term in
  // haversine; the most poleward latitude minimizes both longitude factors.
  return Math.min(
    distanceMeters({ lat: 0, lon: 0 }, { lat: latGap, lon: 0 }),
    distanceMeters({ lat: maxAbsLat, lon: 0 }, { lat: maxAbsLat, lon: lonGap }),
  );
}

function nearestIndexedNode(nodes, point, index) {
  const { cells, cellDegrees, order, bounds } = index;
  const { south, north, west, east } = bounds;
  const maxAbsLat = Math.max(Math.abs(point.lat), Math.abs(south), Math.abs(north));
  const maxLatGap = Math.max(Math.abs(point.lat - south), Math.abs(point.lat - north));
  const maxLonGap = Math.max(Math.abs(point.lon - west), Math.abs(point.lon - east));
  // Use the grid only where longitude differences cannot wrap and
  // haversine distances stay well away from antipodal rounding.
  if (!(maxAbsLat <= 90 && Math.max(Math.abs(point.lon), Math.abs(west), Math.abs(east)) <= 180
    && maxLatGap + maxLonGap <= 90
    && cellDegrees >= CELL_EDGE_PADDING && cellDegrees <= 90)) return null;

  const baseLat = Math.floor(point.lat / cellDegrees);
  const baseLon = Math.floor(point.lon / cellDegrees);
  let best = null;
  let remaining = cells.size;
  for (let ring = 0; ring < 10; ring++) {
    for (let dLat = -ring; dLat <= ring; dLat++) {
      for (let dLon = -ring; dLon <= ring; dLon++) {
        if (Math.max(Math.abs(dLat), Math.abs(dLon)) !== ring) continue;
        const bucket = cells.get(`${baseLat + dLat}:${baseLon + dLon}`);
        if (!bucket) continue;
        remaining--;
        for (const nodeId of bucket) {
          const coord = nodes.get(nodeId);
          const distance = distanceMeters(point, { lat: coord[0], lon: coord[1] });
          if (!best || distance < best.distance
            || (distance === best.distance && order.get(nodeId) < order.get(best.nodeId))) {
            best = { nodeId, distance, coord };
          }
        }
      }
    }
    if (remaining === 0 || (best
      && best.distance < distanceOutsideCells(point, baseLat, baseLon, ring, cellDegrees, maxAbsLat))) {
      return best;
    }
  }
  return null;
}

export function nearestNodeWithDistance(nodes, point, index = null) {
  if (index?.nodes === nodes && index.order.size === nodes.size && nodes.size > 500) {
    const match = nearestIndexedNode(nodes, point, index);
    if (match) return match;
  }
  let best = null;
  for (const [nodeId, candidate] of nodes) {
    const distance = distanceMeters(point, {
      lat: candidate[0],
      lon: candidate[1],
    });
    if (!best || distance < best.distance) {
      best = { nodeId, distance, coord: candidate };
    }
  }
  return best;
}

export function nearestNode(nodes, point) {
  return nearestNodeWithDistance(nodes, point)?.nodeId ?? null;
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
