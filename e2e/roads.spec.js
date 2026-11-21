import { readFileSync } from "node:fs";
import { largeRoadFixture } from "../scripts/road-fixture.mjs";
import { expect, test } from "@playwright/test";
import { polylineIntersectsBounds } from "../public/src/geo.js";

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/osm_simplified.json", import.meta.url)));
const flood = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));
const eligible = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified"];

async function prepare(page, data = fixture) {
  await page.route("**/api/osm**", route => route.fulfill({ json: data }));
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, route => route.fulfill({ contentType: "image/png", body: flood }));
  await page.goto("/");
  await page.evaluate(() => window.floodlensMap.on("roads:rendered", event => {
    if (event.bounds) window.drawnRoadBounds = event.bounds;
  }));
}

async function loadData(page) {
  await page.evaluate(() => {
    const map = window.floodlensMap, fire = map.fire;
    window.loadedRoads = new Promise(resolve => {
      map.fire = function(type, ...args) {
        if (type === "moveend") {
          map.fire = fire;
          map.once("roads:rendered", () => resolve());
        }
        return fire.call(this,type,...args);
      };
    });
  });
  await page.click("#loadButton");
  await page.evaluate(() => window.loadedRoads);
}

async function membership(page, data = fixture) {
  return page.evaluate(roads => {
    const ids = [];
    const key = points => points.map(p => `${p.lat},${p.lon ?? p.lng}`).join(";");
    const byGeometry = new Map(roads.map(road => [key(road.points), road.id]));
    window.floodlensMap.eachLayer(layer => {
      if (![.45, .64].includes(layer.options?.opacity) || !layer.getLatLngs) return;
      const points = layer.getLatLngs();
      ids.push(byGeometry.get(key(points)) ?? "unknown");
    });
    return ids.sort();
  }, data.roads);
}

async function expectViewport(page, data = fixture) {
  const bounds = await page.evaluate(() => {
    const b = window.drawnRoadBounds ?? window.floodlensMap.getBounds();
    return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
  });
  const expected = data.roads.filter(r => eligible.includes(r.kind) && polylineIntersectsBounds(r.points.map(p => [p.lat, p.lon]), bounds)).map(r => r.id).sort();
  await expect.poll(() => membership(page, data)).toEqual(expected);
  return expected;
}

test("roads follow auto-fit and rapid settled movement without changing analysis", async ({ page }, testInfo) => {
  await prepare(page);
  await page.evaluate(() => window.floodlensMap.setView([-6.20, 106.8302], 19, { animate: false }));
  await loadData(page);
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await expect.poll(() => membership(page)).toContain("103");
  await expectViewport(page);
  expect((await membership(page)).filter(id => id === "101")).toHaveLength(1);
  await page.evaluate(() => window.floodlensMap.setView([-6.2, 106.8315], 16, { animate: false }));
  await page.evaluate(() => window.floodlensMap.fire("draw:created", { layer: L.polygon([[-6.1995,106.8312],[-6.2005,106.8312],[-6.2005,106.8318],[-6.1995,106.8318]]) }));
  await expect(page.locator("#afterCount")).toHaveText("3");
  const snapshot = () => page.evaluate(() => ({
    values: ["beforeCount", "afterCount", "beforeDistance", "afterDistance", "facilityList"].map(id => document.getElementById(id).textContent),
    routes: (() => { const result = []; window.floodlensMap.eachLayer(l => { if (l.getLatLngs && l.options.weight >= 3) result.push(l.getLatLngs()); }); return result; })(),
  }));
  const before = await snapshot();
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.floodlensMap.setView([-6.2 + i * .0001, 106.83 + i * .0001], 17 + i % 3, { animate: false });
    window.floodlensMap.setView([-6.2,106.8325],19,{ animate: false });
  });
  await expectViewport(page);
  expect(await membership(page)).toContain("103");
  expect(await snapshot()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath("settled-scenario.png") });
  await page.evaluate(() => window.floodlensMap.setView([-6.24,106.88],19,{ animate: false }));
  await expectViewport(page);
  expect(await membership(page)).toEqual([]);
});

test("crossing roads render even with both vertices outside", async ({ page }) => {
  const data = structuredClone(fixture);
  data.roads.push({ id: "crossing", kind: "residential", points: [{ id: "c1", lat: -6.1997, lon: 106.82 }, { id: "c2", lat: -6.1997, lon: 106.84 }] });
  await prepare(page, data);
  await page.evaluate(() => window.floodlensMap.setView([-6.20,106.8302],19,{ animate: false }));
  await loadData(page);
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await page.evaluate(() => window.floodlensMap.setView([-6.20,106.8302],19,{ animate: false }));
  await expectViewport(page, data);
  expect(await membership(page, data)).toContain("crossing");
});

test("facility markers keep their identity on a pure pan", async ({ page }) => {
  await prepare(page);
  await loadData(page);
  await expect(page.locator("#beforeCount")).toHaveText("5");
  const kept = await page.evaluate(async () => {
    const map = window.floodlensMap;
    map.setView([-6.2,106.8315],17,{ animate: false });
    const markers = () => { const result = []; map.eachLayer(l => { if (l.options.icon?.options.html?.includes("health-pin")) result.push(l); }); return result; };
    const before = markers();
    await new Promise(resolve => { map.once("roads:rendered", resolve); map.panBy([50,0],{ animate: false }); });
    return { count: before.length, kept: before.filter(l => markers().includes(l)).length };
  });
  expect(kept).toEqual({ count: 5, kept: 5 });
});

test("20k roads: small pan completes under 1s without removing retained layers", async ({ page }) => {
  await prepare(page, largeRoadFixture());
  await loadData(page);
  const result = await page.evaluate(async () => {
    const map = window.floodlensMap;
    await new Promise(resolve => { map.once("roads:rendered", resolve); map.setView([-6.2,106.8302],19,{ animate: false }); });
    const roads = () => { const layers = []; map.eachLayer(l => { if ([.45,.64].includes(l.options.opacity)) layers.push(l); }); return layers; };
    const before = roads();
    let removed = 0;
    const listener = e => { if (before.includes(e.layer)) removed++; };
    map.on("layerremove", listener);
    const started = performance.now();
    await new Promise(resolve => { map.once("roads:rendered", resolve); map.panBy([50,0],{ animate: false }); });
    map.off("layerremove", listener);
    return { elapsed: performance.now() - started, removed, retained: before.filter(l => roads().includes(l)).length, count: before.length };
  });
  expect(result.elapsed).toBeLessThan(1000);
  expect(result.count).toBeGreaterThan(100);
  expect(result.count).toBeLessThan(500);
  expect(result.removed).toBe(0);
  expect(result.retained).toBe(result.count);
});

test("superseded batches never add stale layers after the final generation", async ({ page }) => {
  await prepare(page, largeRoadFixture());
  await loadData(page);
  const result = await page.evaluate(async () => {
    const map = window.floodlensMap;
    await new Promise(resolve => { map.once("roads:rendered", () => resolve()); map.setView([-6.4,107.1],19,{ animate: false }); });
    // Force each layer add over the time budget so cancellation always crosses a yield.
    const add = L.Polyline.prototype.onAdd;
    L.Polyline.prototype.onAdd = function(...args) { const end = performance.now() + 9; while (performance.now() < end) {} return add.apply(this,args); };
    let stale = 0, final = false;
    map.on("layeradd", e => { if (final && [.45,.64].includes(e.layer.options.opacity)) stale++; });
    const done = new Promise(resolve => map.once("roads:rendered", resolve));
    map.setView([-6.2,106.8302],19,{ animate: false });
    map.setView([-6.4,107.1],19,{ animate: false });
    await done;
    final = true;
    // Drain old frame/timer continuations, not a wall-clock sleep.
    for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
    L.Polyline.prototype.onAdd = add;
    const roads = []; map.eachLayer(l => { if ([.45,.64].includes(l.options.opacity)) roads.push(l); });
    return { count: roads.length, stale };
  });
  expect(result).toEqual({ count: 0, stale: 0 });
});
