import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { largeRoadFixture } from "./road-fixture.mjs";

const live = process.argv.includes("--live");
const refIndex = process.argv.indexOf("--app-ref");
const ref = refIndex < 0 ? null : process.argv[refIndex + 1];
const env = { ...process.env, FLOODLENS_PORT: "8768", FLOODLENS_HOST: "127.0.0.1" };
delete env.FLOODLENS_FIXTURE_DIR;
if (!live) env.FLOODLENS_FIXTURE_DIR = "tests/fixtures";
const server = spawn(".venv/bin/python", ["server.py"], { env, stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:8768/healthz")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120_000);
  const flood = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, route => route.fulfill({ contentType: "image/png", body: flood }));
  if (!live) await page.route("**/api/osm**", route => route.fulfill({ json: largeRoadFixture() }));
  if (ref) {
    const source = execFileSync("git", ["show", `${ref}:public/src/app.js`], { encoding: "utf8" });
    await page.route("**/src/app.js", route => route.fulfill({ contentType: "text/javascript", body: source }));
  }
  await page.goto("http://127.0.0.1:8768/");
  await page.evaluate(() => {
    const map = window.floodlensMap, fire = map.fire;
    window.initialRoads = new Promise(resolve => {
      map.fire = function(type,...args) {
        if (type === "moveend") {
          map.fire = fire;
          map.once("roads:rendered", () => resolve());
        }
        return fire.call(this,type,...args);
      };
    });
  });
  const responsePromise = page.waitForResponse(response => response.url().includes("/api/osm"));
  await page.click("#loadButton");
  const response = await responsePromise;
  if (!response.ok()) {
    console.log(JSON.stringify({ live, status: response.status(), error: await response.json() }));
  } else {
    const data = await response.json();
    await page.evaluate(() => window.initialRoads);
    await page.evaluate(() => new Promise(resolve => {
      window.floodlensMap.once("roads:rendered", () => resolve());
      window.floodlensMap.setView([-6.2,106.8302],19,{ animate: false });
    }));
    for (const mode of ["street-pan", "auto-fit"]) {
      const result = await page.evaluate(async ({ mode, bounds }) => {
        const map = window.floodlensMap;
        const tasks = [];
        const observer = new PerformanceObserver(list => tasks.push(...list.getEntries()));
        observer.observe({ type: "longtask" });
        const fire = map.fire;
        let started;
        map.fire = function(type,...args) { if (type === "moveend") started = performance.now(); return fire.call(this,type,...args); };
        const complete = new Promise(resolve => map.once("roads:rendered", () => resolve(performance.now())));
        if (mode === "street-pan") map.panBy([50,0],{ animate: false });
        else map.fitBounds([[bounds.south,bounds.west],[bounds.north,bounds.east]],{ animate: false, padding: [16,16] });
        const finished = await complete;
        for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
        const observedUntil = performance.now();
        tasks.push(...observer.takeRecords());
        observer.disconnect();
        map.fire = fire;
        let layers = 0, visible = 0;
        map.eachLayer(layer => {
          if (![.45,.64].includes(layer.options.opacity)) return;
          layers++;
          if (layer.getBounds().intersects(map.getBounds())) visible++;
        });
        return { mode, zoom: map.getZoom(), layers, visible, redrawMs: +(finished - started).toFixed(1), longestTaskMs: Math.max(0,...tasks.filter(t => t.startTime >= started && t.startTime <= observedUntil).map(t => t.duration)) };
      }, { mode, bounds: data.bounds });
      console.log(JSON.stringify({ ref: ref ?? "working-tree", live, roads: data.roads.length, browser: browser.version(), viewport: [1280,720], ...result }));
    }
  }
} finally {
  await browser?.close();
  server.kill();
}
