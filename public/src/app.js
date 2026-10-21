    const FLOOD_BOUNDS = [[-6.43, 106.59], [-5.99, 107.10]];
    const PILOT_BOUNDS = { south: -6.26, west: 106.78, north: -6.14, east: 106.89 };
    const DEFAULT_ORIGIN = { lat: -6.2000, lon: 106.8300, label: "Menteng" };
    const MAX_ACCESS_METERS = 5000;
    const cssTokens = getComputedStyle(document.documentElement);
    const colorToken = (name) => cssTokens.getPropertyValue(name).trim();
    const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([-6.22, 106.83], 11);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 100 }).addTo(map);
    if (["127.0.0.1", "localhost"].includes(location.hostname)) {
      window.floodlensMap = map;
    }
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(map);

    const hazardOverlay = L.imageOverlay("/api/flood", FLOOD_BOUNDS, { opacity: .45, interactive: false, alt: "Layer bahaya banjir BNPB untuk Jabodetabekpunjur" });
    hazardOverlay.addTo(map);
    hazardOverlay.on("load", () => setSourceState("bnpbState", "LAYER AKTIF", "ready"));
    hazardOverlay.on("error", () => {
      setSourceState("bnpbState", "TIDAK TERSEDIA", "error");
      showMapError("Layer BNPB tidak dapat dimuat. Peta dasar dan simulasi jaringan tetap bisa digunakan.");
    });

    const roadsLayer = L.layerGroup().addTo(map);
    const facilitiesLayer = L.layerGroup().addTo(map);
    const closureLayer = L.layerGroup().addTo(map);
    const routeLayer = L.layerGroup().addTo(map);
    const scenarioLayers = new L.FeatureGroup().addTo(map);
    const drawControl = new L.Control.Draw({
      position: "topleft",
      draw: {
        polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: colorToken("--coral"), weight: 2, fillColor: colorToken("--coral"), fillOpacity: .18 } },
        polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false
      },
      edit: { featureGroup: scenarioLayers, edit: true, remove: true }
    });
    map.addControl(drawControl);

    let osmData = null;
    let graph = new Map();
    let graphNodes = new Map();
    let segments = [];
    let facilities = [];
    let origin = { ...DEFAULT_ORIGIN };
    let originMarker = null;
    let activePolygon = null;
    let drawActive = false;
    let baseAnalysis = null;
    let overlayVisible = true;

    const $ = (id) => document.getElementById(id);
    const loadButton = $("loadButton");
    const statusDot = $("statusDot");
    const connectionText = $("connectionText");
    const instructions = $("mapInstructions");

    function setSourceState(id, text, className = "") {
      const node = $(id);
      node.textContent = text;
      node.className = `source-state ${className}`.trim();
    }
    async function fetchOsmData(refresh) {
      const response = await fetch(`/api/osm${refresh ? "?refresh=1" : ""}`, { signal: AbortSignal.timeout(90000) });
      const data = await response.json().catch(() => ({}));
      const error = data.error;
      if (!response.ok || error) {
        const message = typeof error === "string" ? error : error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (!Array.isArray(data.roads) || !Array.isArray(data.facilities)) {
        throw new Error("Respons data jalan tidak lengkap.");
      }
      return data;
    }
    function setStatus(text, state = "") {
      connectionText.textContent = text;
      statusDot.className = `status-dot ${state}`.trim();
    }
    function showMapError(message) {
      const node = $("mapError");
      node.textContent = message;
      node.style.display = "block";
    }
    function hideMapError() { $("mapError").style.display = "none"; }
    function formatKm(meters) { return `${(meters / 1000).toFixed(1)} km`; }
    function distanceMeters(a, b) {
      const r = 6371000;
      const rad = Math.PI / 180;
      const dLat = (b.lat - a.lat) * rad;
      const dLon = (b.lon - a.lon) * rad;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
      return 2 * r * Math.asin(Math.sqrt(x));
    }
    function addAdjacency(from, to, edge) {
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from).push({ to, weight: edge.weight, key: edge.key, segment: edge });
    }
    function buildGraph(data) {
      graph = new Map();
      graphNodes = new Map();
      segments = [];
      for (const road of data.roads) {
        for (let i = 0; i < road.points.length - 1; i++) {
          const a = road.points[i], b = road.points[i + 1];
          if (!a.id || !b.id || a.id === b.id) continue;
          graphNodes.set(a.id, [a.lat, a.lon]);
          graphNodes.set(b.id, [b.lat, b.lon]);
          const edge = {
            key: `${road.id}:${i}`,
            from: a.id,
            to: b.id,
            weight: distanceMeters(a, b),
            a: [a.lat, a.lon],
            b: [b.lat, b.lon],
            name: road.name,
            kind: road.kind
          };
          segments.push(edge);
          if (road.oneway === "-1") addAdjacency(b.id, a.id, edge);
          else {
            addAdjacency(a.id, b.id, edge);
            if (!(["yes", "1", "true"].includes(String(road.oneway).toLowerCase()))) addAdjacency(b.id, a.id, edge);
          }
        }
      }
      return graphNodes.size;
    }
    function nearestNode(point) {
      let best = null, bestDistance = Infinity;
      for (const [nodeId, candidate] of graphNodes) {
        const d = distanceMeters(point, { lat: candidate[0], lon: candidate[1] });
        if (d < bestDistance) { bestDistance = d; best = nodeId; }
      }
      return best;
    }
    class MinHeap {
      constructor() { this.items = []; }
      push(item) {
        this.items.push(item);
        let i = this.items.length - 1;
        while (i > 0) {
          const p = Math.floor((i - 1) / 2);
          if (this.items[p].distance <= item.distance) break;
          this.items[i] = this.items[p]; i = p;
        }
        this.items[i] = item;
      }
      pop() {
        if (!this.items.length) return null;
        const first = this.items[0], last = this.items.pop();
        if (this.items.length) {
          let i = 0;
          while (true) {
            const left = i * 2 + 1, right = left + 1;
            if (left >= this.items.length) break;
            const child = right < this.items.length && this.items[right].distance < this.items[left].distance ? right : left;
            if (this.items[child].distance >= last.distance) break;
            this.items[i] = this.items[child]; i = child;
          }
          this.items[i] = last;
        }
        return first;
      }
      get size() { return this.items.length; }
    }
    function dijkstra(start, blocked = new Set()) {
      const distances = new Map([[start, 0]]);
      const previous = new Map();
      const heap = new MinHeap();
      heap.push({ node: start, distance: 0 });
      while (heap.size) {
        const current = heap.pop();
        if (current.distance !== distances.get(current.node)) continue;
        for (const edge of graph.get(current.node) || []) {
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
    function restorePath(result, end) {
      if (!result.distances.has(end)) return [];
      const coords = [];
      let node = end;
      while (node) {
        const coordinate = graphNodes.get(node);
        if (coordinate) coords.push(coordinate);
        const previous = result.previous.get(node);
        if (!previous) break;
        node = previous.node;
      }
      return coords.reverse();
    }
    function locateFacilities() {
      facilities = (osmData.facilities || []).map((facility) => ({
        ...facility,
        nodeId: nearestNode({ lat: facility.lat, lon: facility.lon })
      })).filter((facility) => facility.nodeId);
    }
    function drawRoads() {
      roadsLayer.clearLayers();
      for (const road of osmData.roads) {
        if (!["motorway", "trunk", "primary", "secondary", "tertiary"].includes(road.kind)) continue;
        const latlngs = road.points.map((p) => [p.lat, p.lon]);
        L.polyline(latlngs, { color: road.kind === "primary" ? colorToken("--road-primary") : colorToken("--road"), weight: road.kind === "primary" ? 2.0 : 1.25, opacity: .64, interactive: false }).addTo(roadsLayer);
      }
      drawFacilities();
    }
    function drawFacilities() {
      facilitiesLayer.clearLayers();
      if (!facilities.length) return;
      const zoom = map.getZoom();
      if (zoom >= 16) {
        for (const facility of facilities) {
          const icon = L.divIcon({ className: "", html: `<div class="health-pin ${facility.kind === "clinic" ? "clinic" : ""}"></div>`, iconSize: [18, 18], iconAnchor: [9, 15] });
          L.marker([facility.lat, facility.lon], { icon, keyboard: true, title: facility.name, alt: facility.name }).bindTooltip(`${escapeHtml(facility.name)} · ${facility.kind === "hospital" ? "rumah sakit" : "klinik / puskesmas"}`, { className: "custom-tooltip" }).addTo(facilitiesLayer);
        }
        return;
      }
      const cellSize = zoom <= 11 ? .04 : zoom === 12 ? .025 : zoom === 13 ? .012 : zoom === 14 ? .006 : .003;
      const clusters = new Map();
      for (const facility of facilities) {
        const key = `${Math.floor(facility.lat / cellSize)}:${Math.floor(facility.lon / cellSize)}`;
        if (!clusters.has(key)) clusters.set(key, { lat: 0, lon: 0, count: 0, hospitals: 0 });
        const cluster = clusters.get(key);
        cluster.lat += facility.lat; cluster.lon += facility.lon; cluster.count++;
        if (facility.kind === "hospital") cluster.hospitals++;
      }
      for (const cluster of clusters.values()) {
        const lat = cluster.lat / cluster.count, lon = cluster.lon / cluster.count;
        const icon = L.divIcon({
          className: "facility-cluster-icon",
          html: `<div class="cluster-bubble ${cluster.hospitals ? "has-hospital" : ""}">${cluster.count}<small>${cluster.hospitals ? `${cluster.hospitals} RS` : "klinik"}</small></div>`,
          iconSize: [38, 42], iconAnchor: [19, 19]
        });
        L.marker([lat, lon], { icon, keyboard: true, title: `${cluster.count} fasilitas kesehatan` })
          .bindTooltip(`${cluster.count} fasilitas · ${cluster.hospitals} rumah sakit`, { className: "custom-tooltip" })
          .on("click", () => map.setView([lat, lon], Math.min(16, map.getZoom() + 2)))
          .addTo(facilitiesLayer);
      }
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function setOrigin(point, label = "Titik pilihan peta") {
      origin = { lat: point.lat, lon: point.lng ?? point.lon, label };
      if (originMarker) map.removeLayer(originMarker);
      const icon = L.divIcon({ className: "", html: '<div class="origin-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
      originMarker = L.marker([origin.lat, origin.lon], { icon, keyboard: true, title: "Titik awal perjalanan" }).addTo(map);
      originMarker.bindTooltip("Titik awal", { className: "custom-tooltip" });
      $("originText").textContent = `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)} · ${origin.label}`;
      $("mapCaption").textContent = `Jakarta · titik awal: ${origin.label}`;
      updateAnalysis();
    }
    function updateInstructions(message, drawing = false) {
      instructions.classList.toggle("is-drawing", drawing);
      const span = instructions.querySelector("span");
      span.textContent = message;
    }
    function pointInPolygon(point, ring) {
      let inside = false;
      const x = point[1], y = point[0];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
        const crosses = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
        if (crosses) inside = !inside;
      }
      return inside;
    }
    function currentRing(layer) {
      const points = layer.getLatLngs();
      return Array.isArray(points[0]) ? points[0] : points;
    }
    function closedSegmentsFor(layer) {
      if (!layer) return new Set();
      const ring = currentRing(layer);
      const closed = new Set();
      for (const segment of segments) {
        const midpoint = [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2];
        if (pointInPolygon(midpoint, ring)) closed.add(segment.key);
      }
      return closed;
    }
    function renderClosures(closed) {
      closureLayer.clearLayers();
      let rendered = 0;
      for (const segment of segments) {
        if (!closed.has(segment.key)) continue;
        L.polyline([segment.a, segment.b], { color: colorToken("--coral"), weight: 3.1, opacity: .95, lineCap: "round", interactive: false }).addTo(closureLayer);
        if (++rendered >= 3500) break;
      }
    }
    function nearestFacility(result, kind = null) {
      let best = null;
      for (const facility of facilities) {
        if (kind && facility.kind !== kind) continue;
        const distance = result.distances.get(facility.nodeId);
        if (distance === undefined) continue;
        if (!best || distance < best.distance) best = { facility, distance };
      }
      return best;
    }
    function facilityRows(result) {
      const sorted = facilities.map((facility) => ({ facility, distance: result.distances.get(facility.nodeId) }))
        .filter((item) => Number.isFinite(item.distance))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
      if (!sorted.length) return '<div class="empty-state">Tidak ada fasilitas yang terhubung pada skenario ini.</div>';
      return sorted.map(({ facility, distance }) => `<div class="facility-row"><strong title="${escapeHtml(facility.name)}">${escapeHtml(facility.name)}</strong><span>${formatKm(distance)}</span></div>`).join("");
    }
    function paintPath(result, facility, color, weight, dashArray = null) {
      if (!facility) return;
      const coords = restorePath(result, facility.nodeId);
      if (coords.length < 2) return;
      L.polyline(coords, { color, weight, opacity: .95, dashArray, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    }
    function updateAnalysis() {
      routeLayer.clearLayers();
      closureLayer.clearLayers();
      if (!osmData || !graph.size) return;
      const start = nearestNode({ lat: origin.lat, lon: origin.lon });
      if (!start) return;
      const baseline = dijkstra(start);
      baseAnalysis = baseline;
      const nearestBaseHospital = nearestFacility(baseline, "hospital");
      const nearestBase = nearestFacility(baseline);
      const closed = closedSegmentsFor(activePolygon);
      renderClosures(closed);
      const scenario = dijkstra(start, closed);
      const nearestScenarioHospital = nearestFacility(scenario, "hospital");
      const nearestScenario = nearestFacility(scenario);
      const beforeInRange = facilities.filter((f) => (baseline.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length;
      const afterInRange = facilities.filter((f) => (scenario.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length;
      const lost = Math.max(0, beforeInRange - afterInRange);

      $("beforeCount").textContent = String(beforeInRange);
      $("afterCount").textContent = String(afterInRange);
      $("beforeSub").textContent = `${facilities.filter((f) => f.kind === "hospital" && (baseline.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length} RS · ${facilities.filter((f) => f.kind === "clinic" && (baseline.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length} klinik`;
      $("afterSub").textContent = activePolygon ? `${facilities.filter((f) => f.kind === "hospital" && (scenario.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length} RS · ${facilities.filter((f) => f.kind === "clinic" && (scenario.distances.get(f.nodeId) ?? Infinity) <= MAX_ACCESS_METERS).length} klinik` : "Gambar zona terdampak";
      $("beforeDistance").textContent = nearestBaseHospital ? formatKm(nearestBaseHospital.distance) : "—";
      $("afterDistance").textContent = nearestScenarioHospital ? formatKm(nearestScenarioHospital.distance) : "—";
      $("detourSub").textContent = activePolygon && nearestBaseHospital && nearestScenarioHospital
        ? `${nearestScenarioHospital.distance >= nearestBaseHospital.distance ? "+" : "−"}${formatKm(Math.abs(nearestScenarioHospital.distance - nearestBaseHospital.distance))} perubahan rute`
        : "Gambar zona terdampak";
      const inaccessible = nearestBase && !nearestScenario;
      $("afterDistance").classList.toggle("warning", Boolean(activePolygon && lost > 0));
      $("resultNote").textContent = !activePolygon
        ? "Baseline rute siap. Gambar poligon pada peta untuk mengasumsikan ruas jalan di dalamnya terputus."
        : `${closed.size.toLocaleString("id-ID")} segmen jalan masuk zona. ${lost ? `${lost} fasilitas keluar dari radius akses 5 km.` : "Belum ada fasilitas yang keluar dari radius akses 5 km."}${inaccessible ? " Tidak ada fasilitas yang tetap terhubung." : ""}`;
      $("facilityList").innerHTML = facilityRows(scenario);
      paintPath(baseline, nearestBaseHospital, colorToken("--baseline"), 3, "5 7");
      paintPath(scenario, nearestScenarioHospital, colorToken("--teal"), 4);
    }

    async function loadData(refresh = false) {
      if (loadButton.disabled) return;
      loadButton.disabled = true;
      $("loadButtonText").textContent = "Mengambil data terbuka…";
      setStatus("Menghubungi Overpass API", "loading");
      setSourceState("osmState", "MENGAMBIL DATA", "");
      hideMapError();
      try {
        const payload = await fetchOsmData(refresh);
        osmData = payload;
        const nodeCount = buildGraph(osmData);
        locateFacilities();
        drawRoads();
        setOrigin({ lat: origin.lat, lon: origin.lon }, origin.label);
        setSourceState("osmState", `${osmData.roads.length.toLocaleString("id-ID")} RUAS`, "ready");
        $("osmSummary").textContent = `${osmData.roads.length.toLocaleString("id-ID")} ruas · ${facilities.length.toLocaleString("id-ID")} fasilitas`;
        setStatus("Data publik siap digunakan", "live");
        $("loadButtonText").textContent = "Perbarui data live";
        updateInstructions("Klik peta untuk mengubah titik awal, atau gambar zona terdampak", false);
        $("mapCaption").textContent = `Jakarta · ${nodeCount.toLocaleString("id-ID")} simpul jalan · ${facilities.length.toLocaleString("id-ID")} fasilitas kesehatan`;
        map.fitBounds([[osmData.bounds.south, osmData.bounds.west], [osmData.bounds.north, osmData.bounds.east]], { padding: [16, 16] });
      } catch (error) {
        setSourceState("osmState", "GAGAL DIMUAT", "error");
        setStatus("Data tidak dapat diakses", "");
        showMapError(`Data jalan gagal dimuat: ${error.message}. Coba muat ulang beberapa saat lagi.`);
        $("loadButtonText").textContent = "Coba muat data lagi";
      } finally {
        loadButton.disabled = false;
      }
    }

    map.on("click", (event) => {
      if (!osmData || drawActive) return;
      setOrigin(event.latlng, "titik pilihan peta");
      updateInstructions("Titik awal diperbarui · gambar poligon untuk menguji dampak", false);
    });
    map.on("draw:drawstart", () => {
      drawActive = true;
      updateInstructions("Klik beberapa titik, lalu tutup poligon untuk menetapkan area terdampak", true);
    });
    map.on("draw:drawstop", () => {
      drawActive = false;
      updateInstructions("Area skenario diperbarui · klik peta untuk mengganti titik awal", false);
    });
    map.on(L.Draw.Event.CREATED, (event) => {
      scenarioLayers.clearLayers();
      scenarioLayers.addLayer(event.layer);
      activePolygon = event.layer;
      updateAnalysis();
      updateInstructions("Zona aktif · atur ulang atau gambar kembali untuk mencoba skenario lain", false);
    });
    map.on(L.Draw.Event.EDITED, () => {
      activePolygon = scenarioLayers.getLayers()[0] || null;
      updateAnalysis();
    });
    map.on(L.Draw.Event.DELETED, () => {
      activePolygon = null;
      updateAnalysis();
      updateInstructions("Zona dihapus · gambar ulang area untuk membandingkan akses", false);
    });
    map.on("zoomend", () => { if (osmData) drawFacilities(); });

    loadButton.addEventListener("click", () => loadData(true));
    $("hazardToggle").addEventListener("change", (event) => {
      overlayVisible = event.target.checked;
      if (overlayVisible) hazardOverlay.addTo(map); else map.removeLayer(hazardOverlay);
    });
    $("clearButton").addEventListener("click", () => {
      scenarioLayers.clearLayers();
      activePolygon = null;
      updateAnalysis();
      updateInstructions("Zona skenario dihapus · gambar poligon untuk memulai", false);
    });
    $("fitButton").addEventListener("click", () => map.setView([-6.22, 106.83], 11));
    $("setOriginButton").addEventListener("click", () => {
      updateInstructions("Klik peta untuk memilih titik awal perjalanan", false);
      $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    map.whenReady(() => setTimeout(() => map.invalidateSize(), 150));
