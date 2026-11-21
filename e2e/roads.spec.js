import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { polylineIntersectsBounds } from "../public/src/geo.js";

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/osm_simplified.json", import.meta.url)));
const flood = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));
const eligible = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified"];

async function prepare(page, data = fixture) {
  await page.route("**/api/osm**", route => route.fulfill({ json: data }));
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, route => route.fulfill({ contentType: "image/png", body: flood }));
  await page.goto("/");
}

async function membership(page, data = fixture) {
  return page.evaluate(roads => {
    const ids = [];
    window.floodlensMap.eachLayer(layer => {
      if (![.45, .64].includes(layer.options?.opacity) || !layer.getLatLngs) return;
      const points = layer.getLatLngs();
      const road = roads.find(r => r.points.length === points.length && r.points.every((p, i) => p.lat === points[i].lat && p.lon === points[i].lng));
      ids.push(road?.id ?? "unknown");
    });
    return ids.sort();
  }, data.roads);
}

async function expectViewport(page, data = fixture) {
  const bounds = await page.evaluate(() => {
    const b = window.floodlensMap.getBounds();
    return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
  });
  const expected = data.roads.filter(r => eligible.includes(r.kind) && polylineIntersectsBounds(r.points.map(p => [p.lat, p.lon]), bounds)).map(r => r.id).sort();
  await expect.poll(() => membership(page, data)).toEqual(expected);
  return expected;
}

test("roads follow auto-fit and rapid settled movement without changing analysis", async ({ page }, testInfo) => {
  await prepare(page);
  await page.evaluate(() => window.floodlensMap.setView([-6.20, 106.8302], 19, { animate: false }));
  await page.click("#loadButton");
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
  await page.click("#loadButton");
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await page.evaluate(() => window.floodlensMap.setView([-6.20,106.8302],19,{ animate: false }));
  await expectViewport(page, data);
  expect(await membership(page, data)).toContain("crossing");
});

test("large fixture redraw yields and discards superseded batches", async ({ page, browser }, testInfo) => {
  const data = structuredClone(fixture);
  for (let i = 0; i < 1600; i++) {
    const lat = -6.2004 + i * .0000005;
    data.roads.push({ id: `large-${i}`, kind: "residential", points: [{ id: `a${i}`, lat, lon: 106.8301 }, { id: `b${i}`, lat, lon: 106.8303 }] });
  }
  await prepare(page, data);
  if (process.env.ROAD_BASELINE === "1") {
    const source = execFileSync("git", ["show", "master:public/src/app.js"], { encoding: "utf8" });
    await page.route("**/src/app.js", route => route.fulfill({ contentType: "text/javascript", body: source.replace("function drawRoads() {", "function drawRoads() { const started = performance.now();").replace("      drawFacilities();\n    }", "      window.baselineDrawMs = performance.now() - started; drawFacilities();\n    }") }));
    await page.reload();
  }
  await page.evaluate(() => {
    window.roadTasks = [];
    window.roadObserver = new PerformanceObserver(list => window.roadTasks.push(...list.getEntries().map(e => e.duration)));
    window.roadObserver.observe({ type: "longtask" });
  });
  await page.click("#loadButton");
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await expectViewport(page, data);
  await page.evaluate(() => {
    const map = window.floodlensMap;
    const fire = map.fire;
    map.fire = function(type, ...args) {
      if (type === "moveend") {
        window.roadStart = performance.now();
        window.roadTicks = 0;
        window.roadTimer = setInterval(() => window.roadTicks++, 0);
      }
      return fire.call(this, type, ...args);
    };
    map.once("roads:rendered", () => {
      window.roadCompleteMs = performance.now() - window.roadStart;
      clearInterval(window.roadTimer);
    });
    window.floodlensMap.setView([-6.20,106.8302],19,{ animate: false });
  });
  if (process.env.ROAD_BASELINE === "1") {
    await page.waitForTimeout(1000);
    console.log("ROAD_BASELINE", JSON.stringify(await page.evaluate(() => ({ initialDrawMs: window.baselineDrawMs, movementCompleted: Number.isFinite(window.roadCompleteMs), longestTaskMs: Math.max(0, ...window.roadTasks), viewport: [innerWidth, innerHeight] }))), browser.version());
    expect(await membership(page, data)).toHaveLength(1610);
    return;
  }
  await expectViewport(page, data);
  await page.waitForFunction(() => Number.isFinite(window.roadCompleteMs));
  expect(await page.evaluate(() => window.roadTicks)).toBeGreaterThan(0);
  const metrics = await page.evaluate(() => ({ settledToCompleteMs: window.roadCompleteMs, longestTaskMs: Math.max(0, ...window.roadTasks), viewport: [innerWidth, innerHeight] }));
  console.log("ROAD_PERF", JSON.stringify({ ...metrics, roads: data.roads.length, browser: browser.version() }));
  expect((await membership(page, data)).length).toBeGreaterThan(500);
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) setTimeout(() => window.floodlensMap.setView([-6.20,106.8302 + i * .01],19,{ animate: false }), i * 5);
  });
  await page.waitForTimeout(200);
  await expectViewport(page, data);
  expect(await membership(page, data)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("settled-empty.png") });
});
