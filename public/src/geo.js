export function distanceMeters(a, b) {
  const radius = 6371000;
  const radians = Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * radians;
  const deltaLon = (b.lon - a.lon) * radians;
  const x =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(deltaLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

export function formatKm(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}

export function pointInPolygon(point, ring) {
  let inside = false;
  const x = point[1];
  const y = point[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    const crosses =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}
