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
  if (!Number.isFinite(meters)) return "—";
  // shortcut: meter precision under 1 km keeps block-level detail readable.
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function isInsideBounds(lat, lon, bounds) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !bounds) return false;
  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lon >= bounds.west &&
    lon <= bounds.east
  );
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

export function ringAreaSquareMeters(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const origin = ring[0];
  let total = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const a = { lat: ring[i].lat - origin.lat, lon: ring[i].lng - origin.lng };
    const b = { lat: ring[i + 1].lat - origin.lat, lon: ring[i + 1].lng - origin.lng };
    const ax = a.lon * 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const ay = a.lat * 110540;
    const bx = b.lon * 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const by = b.lat * 110540;
    total += (ax * by - bx * ay) / 2;
  }
  return Math.abs(total);
}

export function describeSnapQuality(distanceMeters, warnAt = 500) {
  if (!Number.isFinite(distanceMeters)) return "unknown";
  if (distanceMeters <= 50) return "dekat";
  if (distanceMeters <= warnAt) return "sedang";
  return "jauh";
}
