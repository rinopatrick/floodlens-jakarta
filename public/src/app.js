import {
  DEFAULT_ORIGIN,
  FLOOD_BOUNDS,
  MAX_ACCESS_METERS as MAX_ACCESS_FALLBACK,
  PILOT_BOUNDS as PILOT_FALLBACK,
  TILE_LAYER,
} from "./config.js";
import { formatKm, isInsideBounds } from "./geo.js";
import { closedSegmentsFor } from "./analysis.js";
import { buildRenderPayload } from "./analysis-payload.js";
import { buildGraph, dijkstra, nearestNodeWithDistance } from "./graph.js";
let PILOT_BOUNDS = { ...PILOT_FALLBACK };
let MAX_ACCESS_METERS = MAX_ACCESS_FALLBACK;

function isInsidePilot(lat, lon) {
  return isInsideBounds(lat, lon, PILOT_BOUNDS);
}

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

    const hazardOverlay = L.imageOverlay("/api/flood", FLOOD_BOUNDS, { opacity: .3, interactive: false, className: "hazard-overlay", alt: "Layer bahaya banjir BNPB untuk Jabodetabekpunjur" });
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
    const snapLayer = L.layerGroup().addTo(map);
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
    document.querySelectorAll(".leaflet-draw-toolbar a").forEach((link) => {
      link.setAttribute("role", "button");
      link.setAttribute("tabindex", "0");
      if (link.title) link.setAttribute("aria-label", link.title);
    });

    let osmData = null;
    let graphData = { adjacency: new Map(), nodes: new Map(), segments: [] };
    let facilities = [];
    let origin = { ...DEFAULT_ORIGIN };
    let originMarker = null;
    let activePolygon = null;
    let replacedPolygon = null;
    let drawActive = false;
    let originSnap = null;
    let baselineCache = { key: null, result: null };
    let overlayVisible = true;
    let activeLoadController = null;
    let analysisWorker = null;
    let analysisRequestId = 0;
    let hasLoadedData = false;

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
    async function fetchOsmData(refresh, signal) {
      const timeout = AbortSignal.timeout(90000);
      const requestSignal = signal && AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : (signal || timeout);
      const response = await fetch(`/api/osm${refresh ? "?refresh=1" : ""}`, {
        signal: requestSignal,
        cache: refresh ? "no-store" : "default",
      });
      const cooldown = response.headers.get("X-Refresh") === "cooldown";
      const cooldownWait = response.headers.get("X-Refresh-Retry-After");
      const data = await response.json().catch(() => ({}));
      if (cooldown && cooldownWait) {
        setStatus(`Refresh dibatasi, coba lagi dalam ${cooldownWait} dtk`, "");
      }
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
      $("cancelLoad").hidden = !active;
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
        // Single source of truth: server owns bounds and threshold.
        if (config.pilotBounds && Number.isFinite(config.pilotBounds.south)) {
          PILOT_BOUNDS = { ...config.pilotBounds };
        }
        if (Number.isFinite(config.maxAccessMeters)) {
          MAX_ACCESS_METERS = config.maxAccessMeters;
        }
        // Re-check an origin picked before the server bounds arrived.
        if (!isInsidePilot(origin.lat, origin.lon)) {
          setOrigin({ ...DEFAULT_ORIGIN }, DEFAULT_ORIGIN.label);
          $("originError").textContent = "Titik awal di luar area pilot; dikembalikan ke Menteng.";
          $("originError").hidden = false;
        }
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
      $("mapErrorText").textContent = message;
      $("mapError").style.display = "block";
    }
    function hideMapError() { $("mapError").style.display = "none"; }
    function locateFacilities() {
      facilities = (osmData.facilities || []).map((facility) => ({ ...facility }));
    }
    function snapFacilities() {
      facilities = facilities.map((facility) => {
        if (facility.nodeId) return facility;
        const match = nearestNodeWithDistance(graphData.nodes, {
          lat: facility.lat,
          lon: facility.lon,
        });
        return match
          ? { ...facility, nodeId: match.nodeId, snapDistance: match.distance }
          : null;
      }).filter(Boolean);
    }
    function drawRoads() {
      roadsLayer.clearLayers();
      for (const road of osmData.roads) {
        // All routable classes are drawn so routes never float over blank tiles.
        if (!["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified"].includes(road.kind)) continue;
        const minor = !["motorway", "trunk", "primary", "secondary"].includes(road.kind);
        const latlngs = road.points.map((p) => [p.lat, p.lon]);
        L.polyline(latlngs, { color: road.kind === "primary" ? colorToken("--road-primary") : colorToken("--road"), weight: road.kind === "primary" ? 2.0 : minor ? 0.8 : 1.25, opacity: minor ? .45 : .64, interactive: false }).addTo(roadsLayer);
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
      const cellSize = zoom <= 11 ? .08 : zoom === 12 ? .05 : zoom === 13 ? .03 : zoom === 14 ? .015 : zoom === 15 ? .008 : .004;
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
        const marker = L.marker([lat, lon], { icon, keyboard: true, title: `${cluster.count} fasilitas kesehatan` })
          .bindTooltip(`${cluster.count} fasilitas · ${cluster.hospitals} rumah sakit`, { className: "custom-tooltip" });
        // Cluster clicks zoom only; they must not move the origin.
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          map.setView([lat, lon], Math.min(16, map.getZoom() + 2));
        });
        marker.addTo(facilitiesLayer);
      }
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function drawSnapIndicator() {
      snapLayer.clearLayers();
      if (!originSnap || originSnap.distance < 3) return;
      L.polyline(
        [[origin.lat, origin.lon], [originSnap.lat, originSnap.lon]],
        {
          color: colorToken("--rust"),
          weight: 1,
          opacity: .75,
          dashArray: "2 5",
          interactive: false,
        },
      ).addTo(snapLayer);
      L.circleMarker([originSnap.lat, originSnap.lon], {
        radius: 4,
        color: colorToken("--rust"),
        weight: 2,
        fillColor: colorToken("--surface"),
        fillOpacity: 1,
        interactive: false,
      })
        .bindTooltip(
          `Titik analisis · ${Math.round(originSnap.distance)} m dari klik`,
          { className: "custom-tooltip" },
        )
        .addTo(snapLayer);
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
    function setAnalysisPending(pending) {
      $("app").dataset.analysis = pending ? "pending" : "ready";
      $("impact-section").setAttribute("aria-busy", String(pending));
      if (pending) {
        $("resultTag").textContent = "MENGHITUNG…";
      } else {
        $("resultTag").textContent = activePolygon ? "HASIL SKENARIO" : "BASELINE";
      }
    }
    function setAppState(state) {
      $("app").dataset.state = state;
      const labels = {
        empty: "Kosong",
        baseline: "Baseline",
        drawing: "Gambar",
        result: "Hasil",
        error: "Gagal",
      };
      document.querySelectorAll(".state-pill").forEach((pill) => {
        if (pill.dataset.pill === state) {
          pill.setAttribute("aria-current", "step");
        } else {
          pill.removeAttribute("aria-current");
        }
      });
      $("stateAnnouncement").textContent = `Tahap: ${labels[state] || state}`;
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
        rendered++;
      }
      // Full render: every closed segment is drawn so the map never
      // understates the closure count.
      closureLayer._renderedCount = rendered;
    }
    function facilityRowsFromData(rows) {
      if (!rows.length) {
        return '<li class="empty-state">Tidak ada fasilitas yang terhubung pada skenario ini.</li>';
      }
      return rows.map((row, index) => {
        const outOfRange = row.distance > MAX_ACCESS_METERS;
        const snap = row.snapDistance > 500
          ? ` · snap ${Math.round(row.snapDistance)} m`
          : "";
        const rangeNote = outOfRange ? " · di luar radius 5 km" : "";
        return `<li class="facility-row"><span class="facility-index">${index + 1}</span><span class="facility-name" title="${escapeHtml(row.name)}${snap}${rangeNote}">${escapeHtml(row.name)}</span><span class="facility-distance">${formatKm(row.distance)}</span></li>`;
      }).join("");
    }
    function pathsEqual(a, b) {
      if (!a || !b || a.length !== b.length || a.length < 2) return false;
      return a.every((coord, i) => coord[0] === b[i][0] && coord[1] === b[i][1]);
    }
    function paintCoords(coords, color, weight, dashArray = null) {
      if (!coords || coords.length < 2) return;
      L.polyline(coords, {
        color,
        weight,
        opacity: .95,
        dashArray,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(routeLayer);
    }
    function renderRoutePair(baselinePath, scenarioPath) {
      if (baselinePath.length >= 2 && pathsEqual(baselinePath, scenarioPath)) {
        // Identical routes: draw once, label honestly instead of hiding one.
        paintCoords(scenarioPath, colorToken("--teal"), 4);
        $("routeFacilities").textContent += " · rute tidak berubah";
        return;
      }
      paintCoords(baselinePath, colorToken("--baseline"), 3, "5 7");
      paintCoords(scenarioPath, colorToken("--teal"), 4);
    }
    function renderAnalysis(data) {
      setAnalysisPending(false);
      routeLayer.clearLayers();
      closureLayer.clearLayers();
      snapLayer.clearLayers();
      originSnap = data.snap;
      drawSnapIndicator();
      renderClosures(new Set(data.closed));
      const summary = data.summary;
      $("beforeCount").textContent = String(summary.beforeInRange);
      $("afterCount").textContent = String(summary.afterInRange);
      $("beforeSub").textContent = `${summary.beforeHospitals} RS · ${summary.beforeClinics} klinik`;
      $("afterSub").textContent = activePolygon ? `${summary.afterHospitals} RS · ${summary.afterClinics} klinik` : "Gambar zona terdampak";
      $("beforeDistance").textContent = summary.nearestBaseHospital ? formatKm(summary.nearestBaseHospital.distance) : "—";
      const afterInRange = summary.nearestScenarioHospital && summary.nearestScenarioHospital.distance <= MAX_ACCESS_METERS;
      $("afterDistance").textContent = summary.nearestScenarioHospital
        ? formatKm(summary.nearestScenarioHospital.distance) + (afterInRange ? "" : " · di luar radius")
        : "—";
      const delta = summary.nearestBaseHospital && summary.nearestScenarioHospital
        ? summary.nearestScenarioHospital.distance - summary.nearestBaseHospital.distance
        : null;
      $("detourValue").textContent = delta === null ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta))} m`;
      $("detourSub").textContent = activePolygon ? "perubahan jarak jaringan" : "Gambar zona terdampak";
      $("routeFacilities").textContent = summary.nearestBaseHospital && summary.nearestScenarioHospital
        ? `${summary.nearestBaseHospital.name} → ${summary.nearestScenarioHospital.name}`
        : "";
      $("resultTag").textContent = activePolygon ? "HASIL SKENARIO" : "BASELINE";
      $("afterDistance").classList.toggle("warning", Boolean(activePolygon && summary.lost > 0));
      const snapNote = data.farSnaps ? ` ${data.farSnaps} fasilitas di-snap lebih dari 500 m.` : "";
      $("resultNote").textContent = (!activePolygon
        ? "Baseline rute siap. Gambar poligon pada peta untuk mengasumsikan ruas jalan di dalamnya terputus."
        : `${data.closedSize.toLocaleString("id-ID")} segmen jalan masuk zona. ${summary.lost ? `${summary.lost} fasilitas keluar dari radius akses 5 km.` : "Belum ada fasilitas yang keluar dari radius akses 5 km."}${summary.inaccessible ? " Tidak ada fasilitas yang tetap terhubung." : ""}`) + snapNote;
      $("facilityList").innerHTML = facilityRowsFromData(data.rows);
      renderRoutePair(data.baselinePath, data.scenarioPath);
    }
    function updateAnalysisSync() {
      routeLayer.clearLayers();
      closureLayer.clearLayers();
      snapLayer.clearLayers();
      if (!osmData || !graphData.adjacency.size) {
        originSnap = null;
        setAnalysisPending(false);
        setAppState("empty");
        return;
      }
      setAnalysisPending(true);
      if (facilities.some((facility) => !facility.nodeId)) snapFacilities();
      const snap = nearestNodeWithDistance(graphData.nodes, {
        lat: origin.lat,
        lon: origin.lon,
      });
      if (!snap) return;
      originSnap = {
        lat: snap.coord[0],
        lon: snap.coord[1],
        distance: snap.distance,
      };
      if (baselineCache.key !== snap.nodeId) {
        baselineCache = {
          key: snap.nodeId,
          result: dijkstra(graphData.adjacency, snap.nodeId),
        };
      }
      const baseline = baselineCache.result;
      const closed = activePolygon
        ? closedSegmentsFor(graphData.segments, currentRing(activePolygon))
        : new Set();
      const scenario = dijkstra(graphData.adjacency, snap.nodeId, closed);
      renderAnalysis(buildRenderPayload({
        snap,
        baseline,
        scenario,
        closed,
        facilityList: facilities,
        nodes: graphData.nodes,
        maxMeters: MAX_ACCESS_METERS,
      }));
    }
    function createAnalysisWorker() {
      if (typeof Worker === "undefined") return null;
      try {
        const worker = new Worker(
          new URL("./analysis-worker.js", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (event) => {
          const message = event.data;
          if (message.type !== "result") return;
          if (message.requestId !== analysisRequestId) return;
          if (message.empty) {
            setAnalysisPending(false);
            setAppState(osmData ? (activePolygon ? "result" : "baseline") : "empty");
            return;
          }
          renderAnalysis(message);
        };
        worker.onerror = () => {
          console.warn("Analysis worker failed; using the main thread.");
          analysisWorker = null;
          updateAnalysisSync();
        };
        return worker;
      } catch (error) {
        console.warn("Analysis worker unavailable; using the main thread.", error);
        return null;
      }
    }
    function setupAnalysisWorker() {
      if (analysisWorker) analysisWorker.terminate();
      analysisWorker = createAnalysisWorker();
      if (analysisWorker) {
        analysisWorker.postMessage({
          type: "setup",
          graph: graphData,
          facilities,
          maxAccessMeters: MAX_ACCESS_METERS,
        });
      }
    }
    function updateAnalysis() {
      if (!osmData || !graphData.adjacency.size) {
        analysisRequestId += 1;
        routeLayer.clearLayers();
        closureLayer.clearLayers();
        snapLayer.clearLayers();
        originSnap = null;
        setAnalysisPending(false);
        setAppState("empty");
        return;
      }
      if (analysisWorker) {
        setAnalysisPending(true);
        const requestId = ++analysisRequestId;
        const ring = activePolygon
          ? currentRing(activePolygon).map((point) => ({
              lat: point.lat,
              lng: point.lng,
            }))
          : null;
        analysisWorker.postMessage({
          type: "analyze",
          requestId,
          origin: { lat: origin.lat, lon: origin.lon },
          ring,
        });
        return;
      }
      updateAnalysisSync();
    }

    async function loadData(refresh = false) {
      if (loadButton.disabled) return;
      loadButton.disabled = true;
      $("loadButtonText").textContent = "Mengambil data terbuka…";
      setStatus("Menghubungi Overpass API", "loading");
      setSourceState("osmState", "MENGAMBIL DATA", "");
      hideMapError();
      activeLoadController = new AbortController();
      try {
        setLoading(true);
        const payload = await fetchOsmData(refresh, activeLoadController.signal);
        osmData = payload;
        graphData = buildGraph(osmData);
        baselineCache = { key: null, result: null };
        originSnap = null;
        const nodeCount = graphData.nodes.size;
        locateFacilities();
        drawRoads();
        setupAnalysisWorker();
        setOrigin({ lat: origin.lat, lon: origin.lon }, origin.label);
        setSourceState("osmState", `${osmData.roads.length.toLocaleString("id-ID")} RUAS`, "ready");
        $("osmSummary").textContent = `${osmData.roads.length.toLocaleString("id-ID")} ruas · ${facilities.length.toLocaleString("id-ID")} fasilitas`;
        let stamp = "";
        if (payload.dataTimestamp) {
          const parsed = new Date(payload.dataTimestamp);
          if (!Number.isNaN(parsed.getTime())) {
            stamp = new Intl.DateTimeFormat("id-ID", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(parsed);
          }
        }
        if (stamp) {
          $("osmSummary").textContent = `${osmData.roads.length.toLocaleString("id-ID")} ruas · ${facilities.length.toLocaleString("id-ID")} fasilitas · ${stamp}`;
        }
        hasLoadedData = true;
        const fixture = $("app").dataset.fixture === "true";
        setStatus(fixture ? "Data contoh siap digunakan" : "Data publik siap digunakan", "live");
        $("loadButtonText").textContent = fixture ? "Perbarui data contoh" : "Perbarui data live";
        setAppState(activePolygon ? "result" : "baseline");
        updateInstructions("Baseline aktif", "Klik peta untuk mengubah titik awal, atau gambar zona terdampak.", false);
        const caption = $("mapCaption");
        if (caption) caption.textContent = `Jakarta · ${nodeCount.toLocaleString("id-ID")} simpul jalan · ${facilities.length.toLocaleString("id-ID")} fasilitas kesehatan`;
        map.fitBounds([[osmData.bounds.south, osmData.bounds.west], [osmData.bounds.north, osmData.bounds.east]], { padding: [16, 16] });
      } catch (error) {
        if (error.name === "AbortError") {
          setSourceState("osmState", "DIBATALKAN", "");
          setStatus("Pengambilan data dibatalkan", "");
          setAppState(osmData ? (activePolygon ? "result" : "baseline") : "empty");
          hideMapError();
          $("loadButtonText").textContent = osmData
            ? ($("app").dataset.fixture === "true" ? "Perbarui data contoh" : "Perbarui data live")
            : ($("app").dataset.fixture === "true" ? "Muat data contoh" : "Muat data live");
        } else {
          hasLoadedData = false;
          setSourceState("osmState", "GAGAL DIMUAT", "error");
          setStatus("Data tidak dapat diakses", "");
          setAppState("error");
          showMapError(`Data jalan gagal dimuat: ${String(error.message).replace(/[.!?]+$/, "")}. Coba muat ulang beberapa saat lagi.`);
          $("loadButtonText").textContent = $("app").dataset.fixture === "true" ? "Coba muat data contoh" : "Coba muat data lagi";
        }
      } finally {
        setLoading(false);
        loadButton.disabled = false;
        activeLoadController = null;
      }
    }

    map.on("click", (event) => {
      if (!osmData || drawActive) return;
      if (!isInsidePilot(event.latlng.lat, event.latlng.lng)) {
        updateInstructions("Di luar area pilot", "Pilih titik di dalam kotak Jakarta Pusat.", false);
        return;
      }
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
      replacedPolygon = activePolygon;
      $("undoPolygon").hidden = !replacedPolygon;
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
      replacedPolygon = null;
      $("undoPolygon").hidden = true;
      updateAnalysis();
      setAppState(osmData ? "baseline" : "empty");
      updateInstructions("Zona dihapus", "Gambar ulang area untuk membandingkan akses.", false);
    });
    map.on("zoomend", () => { if (osmData) drawFacilities(); });

    loadButton.addEventListener("click", () => loadData(hasLoadedData));
    $("cancelLoad").addEventListener("click", () => {
      if (activeLoadController) activeLoadController.abort();
    });
    $("retryButton").addEventListener("click", () => loadData(false));
    function applyCoordinateInput() {
      const lat = Number($("originLat").value.replace(",", "."));
      const lon = Number($("originLon").value.replace(",", "."));
      if (isInsidePilot(lat, lon)) {
        $("originError").hidden = true;
        $("originLat").removeAttribute("aria-invalid");
        $("originLon").removeAttribute("aria-invalid");
        setOrigin({ lat, lon }, "koordinat manual");
        updateInstructions("Titik awal diperbarui", "Gambar poligon untuk menguji dampak akses.", false);
        return;
      }
      // Keep the typed values so the user can fix them; explain inline.
      $("originError").textContent = `Koordinat di luar area pilot (${PILOT_BOUNDS.south.toFixed(2)} s.d. ${PILOT_BOUNDS.north.toFixed(2)}, ${PILOT_BOUNDS.west.toFixed(2)} s.d. ${PILOT_BOUNDS.east.toFixed(2)}).`;
      $("originError").hidden = false;
      $("originLat").setAttribute("aria-invalid", "true");
      $("originLon").setAttribute("aria-invalid", "true");
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
      replacedPolygon = null;
      $("undoPolygon").hidden = true;
      updateAnalysis();
      setAppState(osmData ? "baseline" : "empty");
      updateInstructions("Zona skenario dihapus", "Gambar poligon untuk memulai.", false);
    });
    $("undoPolygon").addEventListener("click", () => {
      if (!replacedPolygon) return;
      scenarioLayers.clearLayers();
      scenarioLayers.addLayer(replacedPolygon);
      activePolygon = replacedPolygon;
      replacedPolygon = null;
      $("undoPolygon").hidden = true;
      updateAnalysis();
      setAppState("result");
      updateInstructions("Zona sebelumnya dipulihkan", "Ruas tertutup saat titik tengahnya berada di dalam poligon.", false);
    });
    $("fitButton").addEventListener("click", () => {
      if (osmData?.bounds) {
        const { south, west, north, east } = osmData.bounds;
        map.fitBounds([[south, west], [north, east]], { padding: [16, 16] });
        return;
      }
      map.setView([-6.22, 106.83], 11);
    });
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
    const panelTabs = [...document.querySelectorAll("[data-panel-target]")];
    panelTabs.forEach((tab, index) => {
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? panelTabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + panelTabs.length) % panelTabs.length;
        showPanel(panelTabs[next].dataset.panelTarget);
        panelTabs[next].focus();
      });
    });
    map.getContainer().addEventListener("keydown", (event) => {
      const target = event.target;
      if (
        (event.key === "Enter" || event.key === " ") &&
        target instanceof Element &&
        target.matches(".leaflet-draw-toolbar a, .leaflet-draw-actions a")
      ) {
        event.preventDefault();
        target.click();
      }
    });
    loadRuntimeConfig();
    map.whenReady(() => setTimeout(() => map.invalidateSize(), 150));
