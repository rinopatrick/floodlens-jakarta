export function readStaleness(headers) {
  const stale = headers.get("X-Data-Stale") === "1";
  const rawAge = (headers.get("X-Data-Age") || "").trim();
  const ageSeconds = /^\d+$/.test(rawAge) ? Number(rawAge) : null;
  return { stale, ageSeconds };
}

export function formatDataAge(ageSeconds) {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return null;
  if (ageSeconds < 60) return "kurang dari 1 menit lalu";
  if (ageSeconds < 3600) return `± ${Math.floor(ageSeconds / 60)} menit lalu`;
  if (ageSeconds < 86400) return `± ${Math.floor(ageSeconds / 3600)} jam lalu`;
  return `± ${Math.floor(ageSeconds / 86400)} hari lalu`;
}

export function describeStaleNotice(ageSeconds) {
  const age = formatDataAge(ageSeconds);
  const base = "Pembaruan dari OpenStreetMap gagal. Menampilkan data cache terakhir";
  return age ? `${base} (${age}).` : `${base}.`;
}

export function osmRequestCache(refresh) {
  return refresh ? "no-store" : "no-cache";
}
