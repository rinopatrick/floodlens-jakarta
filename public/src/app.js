import {
  DEFAULT_ORIGIN,
  FLOOD_BOUNDS,
  MAX_ACCESS_METERS,
  PILOT_BOUNDS,
  TILE_LAYER,
} from "./config.js";
import { distanceMeters, formatKm, pointInPolygon } from "./geo.js";
import { analyzeScenario, closedSegmentsFor } from "./analysis.js";
import {
  buildGraph,
  dijkstra,
  nearestNode,
  restorePath,
} from "./graph.js";

    const cssTokens = getComputedStyle(document.documentElement);
    const colorToken = (name) => cssTokens.getPropertyValue(name).trim();
    const map = L.map("map", { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([-6.22, 106.83], 11);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 100 }).addTo(map);
    Object.assign(L.drawLocal.draw.toolbar.actions, {
      title: "Batal menggambar",
      text: "Batal"
    });
    Object.assign(L.drawLocal.draw.toolbar.finish, {
      title: "Selesaikan gambar",
      text: "Selesai"
    });
    Object.assign(L.drawLocal.draw.toolbar.undo, {
      title: "Hapus titik terakhir",
      text: "Hapus titik"
    });
    Object.assign(L.drawLocal.draw.toolbar.buttons, {
      polyline: "Gambar garis",
      polygon: "Gambar zona",
      rectangle: "Gambar persegi",
      circle: "Gambar lingkaran",
      marker: "Tandai titik",
      circlemarker: "Tandai lingkaran"
    });
    Object.assign(L.drawLocal.draw.handlers.polygon.tooltip, {
      start: "Klik untuk mulai menggambar zona.",
      cont: "Klik untuk melanjutkan.",
      end: "Klik titik pertama untuk menutup zona."
    });
    Object.assign(L.drawLocal.edit.toolbar.actions.save, {
      title: "Simpan perubahan",
      text: "Simpan"
    });
    Object.assign(L.drawLocal.edit.toolbar.actions.cancel, {
      title: "Batal mengedit",
      text: "Batal"
    });
    Object.assign(L.drawLocal.edit.toolbar.actions.clearAll, {
      title: "Hapus semua",
      text: "Hapus semua"
    });
    Object.assign(L.drawLocal.edit.toolbar.buttons, {
      edit: "Edit zona",
      editDisabled: "Belum ada zona",
      remove: "Hapus zona",
      removeDisabled: "Belum ada zona"
    });
    L.drawLocal.edit.handlers.edit.tooltip.text = "Geser titik untuk mengedit zona.";
    L.drawLocal.edit.handlers.edit.tooltip.subtext = "Klik Batal untuk membatalkan.";
    L.drawLocal.edit.handlers.remove.tooltip.text = "Klik zona untuk menghapus.";
    if (["127.0.0.1", "localhost"].includes(location.hostname)) {
      window.floodlensMap = map;
    }
    L.tileLayer(TILE_LAYER.url, {
      maxZoom: TILE_LAYER.maxZoom,
      attribution: TILE_LAYER.attribution
    }).addTo(map);

    const hazardOverlay = L.imageOverlay("/api/flood", FLOOD_BOUNDS, { opacity: .45, interactive: false, className: "hazard-overlay", alt: "Layer bahaya banjir BNPB untuk Jabodetabekpunjur" });
    hazardOverlay.addTo(map);
    hazardOverlay.on("load", () => {
      if ($("app").dataset.fixture === "true") return;
      setSourceState("bnpbState", "LAYER AKTIF", "ready");
    });
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
    let graphData = { adjacency: new Map(), nodes: new Map(), segments: [] };
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
    let loadTimer = null;
    function setLoading(active) {
      const app = $("app");
      app.dataset.loading = active ? "true" : "false";
      app.setAttribute("aria-busy", String(active));
      $("loadProgress").hidden = !active;
      if (active) {
        const started = performance.now();
        $("loadProgressText").textContent = "Mengambil data… 0 dtk";
        clearInterval(loadTimer);
        loadTimer = setInterval(() => {
          const seconds = Math.round((performance.now() - started) / 1000);
          $("loadProgressText").textContent = `Mengambil data… ${seconds} dtk`;
        }, 1000);
      } else {
        clearInterval(loadTimer);
        loadTimer = null;
        $("loadProgressText").textContent = "";
      }
    }
    async function loadRuntimeConfig() {
      try {
        const response = await fetch("/api/config", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const config = await response.json();
        if (!config.fixtureMode) return;
        $("app").dataset.fixture = "true";
        $("loadButtonText").textContent = "Muat data contoh";
        $("sourceNote").textContent = "Mode fixture: snapshot lokal untuk demo dan test. Data live tidak diambil.";
        setSourceState("bnpbState", "FIXTURE · NONAKTIF", "");
        $("hazardToggle").checked = false;
        $("hazardToggle").disabled = true;
        $("app").dataset.hazard = "off";
        overlayVisible = false;
        if (map.hasLayer(hazardOverlay)) map.removeLayer(hazardOverlay);
      } catch {
        // Keep the live-data path when the runtime config is unavailable.
      }
    }
    function showMapError(message) {
      const node = $("mapError");
      node.textContent = message;
      node.style.display = "block";
    }
    function hideMapError() { $("mapError").style.display = "none"; }
    function locateFacilities() {
      facilities = (osmData.facilities || []).map((facility) => ({
        ...facility,
        nodeId: nearestNode(graphData.nodes, { lat: facility.lat, lon: facility.lon })
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
      $("originLat").value = origin.lat.toFixed(4);
      $("originLon").value = origin.lon.toFixed(4);
      const caption = $("mapCaption");
      if (caption) caption.textContent = `Jakarta · titik awal: ${origin.label}`;
      updateAnalysis();
    }
    function setAppState(state) {
      $("app").dataset.state = state;
    }
    function updateInstructions(title, message, drawing = false) {
      instructions.classList.toggle("is-drawing", drawing);
      $("instructionTitle").textContent = title;
      $("instructionCopy").textContent = message;
    }
    function showPanel(target) {
      $("panelBody").dataset.activePanel = target;
      document.querySelectorAll("[data-panel-target]").forEach((candidate) => {
        const active = candidate.dataset.panelTarget === target;
        candidate.setAttribute("aria-selected", String(active));
        candidate.tabIndex = active ? 0 : -1;
      });
    }
    function revealImpact() {
      if (window.matchMedia("(max-width: 720px), (max-height: 760px)").matches) {
        showPanel("impact");
        $("panelBody").scrollTop = 0;
        return;
      }
      const panel = $("panelBody");
      const impact = $("impact-section");
      panel.scrollTo({ top: Math.max(0, impact.offsetTop - 8), behavior: "smooth" });
    }
    function currentRing(layer) {
      const points = layer.getLatLngs();
      return Array.isArray(points[0]) ? points[0] : points;
    }
    function renderClosures(closed) {
      closureLayer.clearLayers();
      let rendered = 0;
      for (const segment of graphData.segments) {
        if (!closed.has(segment.key)) continue;
        L.polyline([segment.a, segment.b], { color: colorToken("--coral"), weight: 3.1, opacity: .95, lineCap: "round", interactive: false }).addTo(closureLayer);
        if (++rendered >= 3500) break;
      }
    }
    function facilityRows(result) {
      const sorted = facilities.map((facility) => ({ facility, distance: result.distances.get(facility.nodeId) }))
        .filter((item) => Number.isFinite(item.distance))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
      if (!sorted.length) return '<li class="empty-state">Tidak ada fasilitas yang terhubung pada skenario ini.</li>';
      return sorted.map(({ facility, distance }, index) => `<li class="facility-row"><span class="facility-index">${index + 1}</span><span class="facility-name" title="${escapeHtml(facility.name)}">${escapeHtml(facility.name)}</span><span class="facility-distance">${formatKm(distance)}</span></li>`).join("");
    }
    function paintPath(result, facility, color, weight, dashArray = null) {
      if (!facility) return;
      const coords = restorePath(graphData.nodes, result, facility.nodeId);
      if (coords.length < 2) return;
      L.polyline(coords, { color, weight, opacity: .95, dashArray, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    }
    function updateAnalysis() {
      routeLayer.clearLayers();
      closureLayer.clearLayers();
      if (!osmData || !graphData.adjacency.size) {
        setAppState("empty");
        return;
      }
      const start = nearestNode(graphData.nodes, { lat: origin.lat, lon: origin.lon });
      if (!start) return;
      const baseline = dijkstra(graphData.adjacency, start);
      baseAnalysis = baseline;
      const closed = activePolygon
        ? closedSegmentsFor(graphData.segments, currentRing(activePolygon))
        : new Set();
      renderClosures(closed);
      const scenario = dijkstra(graphData.adjacency, start, closed);
      const summary = analyzeScenario({
        facilities,
        baseline,
        scenario,
        closed,
        maxAccessMeters: MAX_ACCESS_METERS,
      });

      $("beforeCount").textContent = String(summary.beforeInRange);
      $("afterCount").textContent = String(summary.afterInRange);
      $("beforeSub").textContent = `${summary.beforeHospitals} RS · ${summary.beforeClinics} klinik`;
      $("afterSub").textContent = activePolygon ? `${summary.afterHospitals} RS · ${summary.afterClinics} klinik` : "Gambar zona terdampak";
      $("beforeDistance").textContent = summary.nearestBaseHospital ? formatKm(summary.nearestBaseHospital.distance) : "—";
      $("afterDistance").textContent = summary.nearestScenarioHospital ? formatKm(summary.nearestScenarioHospital.distance) : "—";
      const delta = summary.nearestBaseHospital && summary.nearestScenarioHospital
        ? summary.nearestScenarioHospital.distance - summary.nearestBaseHospital.distance
        : null;
      $("detourValue").textContent = delta === null ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta))} m`;
      $("detourSub").textContent = activePolygon ? "perubahan jarak jaringan" : "Gambar zona terdampak";
      $("resultTag").textContent = activePolygon ? "HASIL SKENARIO" : "BASELINE";
      $("afterDistance").classList.toggle("warning", Boolean(activePolygon && summary.lost > 0));
      $("resultNote").textContent = !activePolygon
        ? "Baseline rute siap. Gambar poligon pada peta untuk mengasumsikan ruas jalan di dalamnya terputus."
        : `${closed.size.toLocaleString("id-ID")} segmen jalan masuk zona. ${summary.lost ? `${summary.lost} fasilitas keluar dari radius akses 5 km.` : "Belum ada fasilitas yang keluar dari radius akses 5 km."}${summary.inaccessible ? " Tidak ada fasilitas yang tetap terhubung." : ""}`;
      $("facilityList").innerHTML = facilityRows(scenario);
      paintPath(baseline, summary.nearestBaseHospital, colorToken("--baseline"), 3, "5 7");
      paintPath(scenario, summary.nearestScenarioHospital, colorToken("--teal"), 4);
    }

    async function loadData(refresh = false) {
      if (loadButton.disabled) return;
      loadButton.disabled = true;
      $("loadButtonText").textContent = "Mengambil data terbuka…";
      setStatus("Menghubungi Overpass API", "loading");
      setSourceState("osmState", "MENGAMBIL DATA", "");
      hideMapError();
      setLoading(true);
      try {
        const payload = await fetchOsmData(refresh);
        osmData = payload;
        graphData = buildGraph(osmData);
        const nodeCount = graphData.nodes.size;
        locateFacilities();
        drawRoads();
        setOrigin({ lat: origin.lat, lon: origin.lon }, origin.label);
        setSourceState("osmState", `${osmData.roads.length.toLocaleString("id-ID")} RUAS`, "ready");
        $("osmSummary").textContent = `${osmData.roads.length.toLocaleString("id-ID")} ruas · ${facilities.length.toLocaleString("id-ID")} fasilitas`;
        const fixture = $("app").dataset.fixture === "true";
        setStatus(fixture ? "Data contoh siap digunakan" : "Data publik siap digunakan", "live");
        $("loadButtonText").textContent = fixture ? "Perbarui data contoh" : "Perbarui data live";
        setAppState(activePolygon ? "result" : "baseline");
        updateInstructions("Baseline aktif", "Klik peta untuk mengubah titik awal, atau gambar zona terdampak.", false);
        const caption = $("mapCaption");
        if (caption) caption.textContent = `Jakarta · ${nodeCount.toLocaleString("id-ID")} simpul jalan · ${facilities.length.toLocaleString("id-ID")} fasilitas kesehatan`;
        map.fitBounds([[osmData.bounds.south, osmData.bounds.west], [osmData.bounds.north, osmData.bounds.east]], { padding: [16, 16] });
      } catch (error) {
        setSourceState("osmState", "GAGAL DIMUAT", "error");
        setStatus("Data tidak dapat diakses", "");
        setAppState("error");
        showMapError(`Data jalan gagal dimuat: ${error.message}. Coba muat ulang beberapa saat lagi.`);
        $("loadButtonText").textContent = $("app").dataset.fixture === "true" ? "Coba muat data contoh" : "Coba muat data lagi";
      } finally {
        setLoading(false);
        loadButton.disabled = false;
      }
    }

    map.on("click", (event) => {
      if (!osmData || drawActive) return;
      setOrigin(event.latlng, "titik pilihan peta");
      updateInstructions("Titik awal diperbarui", "Gambar poligon untuk menguji dampak akses.", false);
    });
    map.on("draw:drawstart", () => {
      drawActive = true;
      setAppState("drawing");
      updateInstructions("Gambar area skenario", "Klik beberapa titik, lalu tutup poligon untuk menetapkan area terdampak.", true);
    });
    map.on("draw:drawstop", () => {
      drawActive = false;
      setAppState(activePolygon ? "result" : (osmData ? "baseline" : "empty"));
      updateInstructions(
        activePolygon ? "Zona skenario aktif" : "Baseline aktif",
        activePolygon ? "Ruas tertutup saat titik tengahnya berada di dalam poligon." : "Klik peta untuk mengganti titik awal.",
        false,
      );
    });
    map.on(L.Draw.Event.CREATED, (event) => {
      scenarioLayers.clearLayers();
      scenarioLayers.addLayer(event.layer);
      activePolygon = event.layer;
      updateAnalysis();
      setAppState("result");
      updateInstructions("Zona skenario aktif", "Ruas tertutup saat titik tengahnya berada di dalam poligon.", false);
      revealImpact();
    });
    map.on(L.Draw.Event.EDITED, () => {
      activePolygon = scenarioLayers.getLayers()[0] || null;
      updateAnalysis();
      setAppState(activePolygon ? "result" : (osmData ? "baseline" : "empty"));
      updateInstructions("Zona skenario diperbarui", "Ruas tertutup saat titik tengahnya berada di dalam poligon.", false);
    });
    map.on(L.Draw.Event.DELETED, () => {
      activePolygon = null;
      updateAnalysis();
      setAppState(osmData ? "baseline" : "empty");
      updateInstructions("Zona dihapus", "Gambar ulang area untuk membandingkan akses.", false);
    });
    map.on("zoomend", () => { if (osmData) drawFacilities(); });

    loadButton.addEventListener("click", () => loadData(true));
    function applyCoordinateInput() {
      const lat = Number($("originLat").value.replace(",", "."));
      const lon = Number($("originLon").value.replace(",", "."));
      const { south, west, north, east } = PILOT_BOUNDS;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= south && lat <= north &&
        lon >= west && lon <= east
      ) {
        setOrigin({ lat, lon }, "koordinat manual");
        updateInstructions("Titik awal diperbarui", "Gambar poligon untuk menguji dampak akses.", false);
        return;
      }
      $("originLat").value = origin.lat.toFixed(4);
      $("originLon").value = origin.lon.toFixed(4);
      setStatus("Koordinat di luar area pilot", "");
    }
    $("originLat").addEventListener("change", applyCoordinateInput);
    $("originLon").addEventListener("change", applyCoordinateInput);
    $("hazardToggle").addEventListener("change", (event) => {
      overlayVisible = event.target.checked;
      $("app").dataset.hazard = overlayVisible ? "on" : "off";
      setSourceState("bnpbState", overlayVisible ? "LAYER AKTIF" : "NONAKTIF", overlayVisible ? "ready" : "");
      if (overlayVisible) hazardOverlay.addTo(map); else map.removeLayer(hazardOverlay);
    });
    $("clearButton").addEventListener("click", () => {
      scenarioLayers.clearLayers();
      activePolygon = null;
      updateAnalysis();
      setAppState(osmData ? "baseline" : "empty");
      updateInstructions("Zona skenario dihapus", "Gambar poligon untuk memulai.", false);
    });
    $("fitButton").addEventListener("click", () => map.setView([-6.22, 106.83], 11));
    $("setOriginButton").addEventListener("click", () => {
      updateInstructions("Pilih titik awal", "Klik peta untuk memilih titik awal perjalanan.", false);
      $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("applyButton").addEventListener("click", () => {
      if (!osmData) {
        updateInstructions("Muat data dulu", "Klik Muat data untuk menyusun baseline.", false);
        return;
      }
      updateAnalysis();
      setAppState(activePolygon ? "result" : "baseline");
      revealImpact();
    });
    document.querySelectorAll("[data-panel-target]").forEach((button) => {
      button.addEventListener("click", () => showPanel(button.dataset.panelTarget));
    });
    loadRuntimeConfig();
    map.whenReady(() => setTimeout(() => map.invalidateSize(), 150));
