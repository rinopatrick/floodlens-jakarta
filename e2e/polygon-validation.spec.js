import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const floodFixture = readFileSync(
  new URL("../tests/fixtures/flood.png", import.meta.url),
);

// Closes the bridge: 5 → 3 facilities in range, 332 m → 556 m.
const RING = [
  [-6.1995, 106.8312],
  [-6.2005, 106.8312],
  [-6.2005, 106.8318],
  [-6.1995, 106.8318],
];

// Overlaps no road midpoint, so it closes nothing (5 → 5).
const NORTH_RING = [
  [-6.1986, 106.8308],
  [-6.1992, 106.8308],
  [-6.1992, 106.832],
  [-6.1986, 106.832],
];

// About 9 m × 9 m: below the 100 m² minimum zone area.
const TINY_RING = [
  [-6.19886, 106.83136],
  [-6.19894, 106.83136],
  [-6.19894, 106.83144],
  [-6.19886, 106.83144],
];

// Five vertices: over the limit when the server allows four.
const PENTAGON = [
  [-6.1995, 106.8312],
  [-6.2005, 106.8312],
  [-6.2005, 106.8318],
  [-6.1995, 106.8318],
  [-6.1993, 106.8315],
];

const MODES = [
  { name: "worker", disableWorker: false },
  { name: "main-thread fallback", disableWorker: true },
];

async function loadFixtureMap(page, { disableWorker, maxPolygonVertices } = {}) {
  if (disableWorker) {
    await page.addInitScript(() => {
      delete window.Worker;
    });
  }
  if (maxPolygonVertices) {
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, maxPolygonVertices } });
    });
  }
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );
  await page.goto("/");
  await page.locator("#loadButton").click();
  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  await expect(page.locator("#afterCount")).toHaveText("5");
  await page.waitForTimeout(1200);
  await setView(page, [-6.2, 106.8315], 16);
}

async function setView(page, center, zoom) {
  await page.evaluate(
    ([c, z]) => window.floodlensMap.setView(c, z, { animate: false }),
    [center, zoom],
  );
  await expect
    .poll(() => page.evaluate(() => window.floodlensMap.getZoom()))
    .toBe(zoom);
}

async function containerPoints(page, ring) {
  return page.evaluate((r) => r.map(([lat, lng]) => {
    const point = window.floodlensMap.latLngToContainerPoint([lat, lng]);
    return { x: point.x, y: point.y };
  }), ring);
}

async function drawPolygon(page, ring) {
  await page.locator(".leaflet-draw-draw-polygon").click();
  const mapBox = await page.locator("#map").boundingBox();
  for (const point of await containerPoints(page, ring)) {
    await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);
    await page.waitForTimeout(350);
  }
  await page.locator(".leaflet-draw-actions a").filter({ hasText: "Selesai" }).click();
}

async function drawTinyPolygon(page) {
  await setView(page, [-6.1989, 106.8314], 18);
  await drawPolygon(page, TINY_RING);
  await setView(page, [-6.2, 106.8315], 16);
}

// The scenario polygons currently drawn on the map, as vertex counts and bounds.
async function dragOnMap(page, latlng, dx, dy) {
  const mapBox = await page.locator("#map").boundingBox();
  const [point] = await containerPoints(page, [latlng]);
  await page.mouse.move(mapBox.x + point.x, mapBox.y + point.y);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + point.x + dx, mapBox.y + point.y + dy, { steps: 5 });
  await page.mouse.up();
}

function scenarioPolygons(page) {
  return page.evaluate(() => {
    const polygons = [];
    window.floodlensMap.eachLayer((layer) => {
      if (!(layer instanceof window.L.Polygon)) return;
      const ring = layer.getLatLngs()[0];
      const bounds = layer.getBounds();
      polygons.push({
        vertices: ring.length,
        south: Number(bounds.getSouth().toFixed(4)),
        north: Number(bounds.getNorth().toFixed(4)),
      });
    });
    return polygons;
  });
}

// Road, closure and route lines drawn on the map.
function polylineCount(page) {
  return page.evaluate(() => {
    let count = 0;
    window.floodlensMap.eachLayer((layer) => {
      if (layer instanceof window.L.Polyline && !(layer instanceof window.L.Polygon)) count++;
    });
    return count;
  });
}

async function expectZoneRejected(page, message) {
  await expect(page.locator("#mapInstructions")).toHaveClass(/is-error/);
  await expect(page.locator("#instructionTitle")).toHaveText("Zona ditolak");
  await expect(page.locator("#instructionCopy")).toContainText(message);
  // A rejected zone is not a data-source failure and must not block the map.
  await expect(page.locator("#mapError")).toBeHidden();
}

async function expectZoneAccepted(page) {
  await expect(page.locator("#mapInstructions")).not.toHaveClass(/is-error/);
  await expect(page.locator("#mapError")).toBeHidden();
}

async function expectBridgeScenario(page) {
  await expect(page.locator("#app")).toHaveAttribute("data-state", "result");
  await expect(page.locator("#resultTag")).toHaveText("HASIL SKENARIO");
  await expect(page.locator("#afterCount")).toHaveText("3");
  await expect(page.locator("#afterDistance")).toHaveText("556 m");
  await expect(page.locator("#detourValue")).toHaveText("+224 m");
  await expect(page.locator("#facilityList .facility-row")).toHaveCount(3);
  expect(await scenarioPolygons(page)).toEqual([
    { vertices: 4, south: -6.2005, north: -6.1995 },
  ]);
}

async function expectBaseline(page) {
  await expect(page.locator("#app")).toHaveAttribute("data-state", "baseline");
  await expect(page.locator("#resultTag")).toHaveText("BASELINE");
  await expect(page.locator("#afterCount")).toHaveText("5");
  await expect(page.locator("#afterSub")).toHaveText("Gambar zona terdampak");
  expect(await scenarioPolygons(page)).toEqual([]);
}

for (const mode of MODES) {
  test.describe(`rejected polygons (${mode.name})`, () => {
    test("a too-small polygon keeps the previous scenario current", async ({ page }) => {
      await loadFixtureMap(page, mode);
      await drawPolygon(page, RING);
      await expectBridgeScenario(page);
      const lines = await polylineCount(page);

      await drawTinyPolygon(page);

      await expectZoneRejected(page, "Zona terlalu kecil");
      await expectBridgeScenario(page);
      expect(await polylineCount(page)).toBe(lines);
      await expect(page.locator("#undoPolygon")).toBeHidden();
    });

    test("a first too-small polygon leaves the baseline in place", async ({ page }) => {
      await loadFixtureMap(page, mode);

      await drawTinyPolygon(page);

      await expectZoneRejected(page, "Zona terlalu kecil");
      await expectBaseline(page);
      await expect(page.locator("#undoPolygon")).toBeHidden();
    });

    test("an over-limit polygon keeps the previous scenario current", async ({ page }) => {
      await loadFixtureMap(page, { ...mode, maxPolygonVertices: 4 });
      await drawPolygon(page, RING);
      await expectBridgeScenario(page);

      await drawPolygon(page, PENTAGON);

      await expectZoneRejected(page, "Poligon terlalu detail");
      await expectBridgeScenario(page);
      await expect(page.locator("#undoPolygon")).toBeHidden();
    });

    test("an over-limit edit is reverted and keeps the scenario current", async ({ page }) => {
      await loadFixtureMap(page, { ...mode, maxPolygonVertices: 4 });
      await drawPolygon(page, RING);
      await expectBridgeScenario(page);

      await page.locator(".leaflet-draw-edit-edit").click();
      // Dragging the midpoint handle between two vertices adds a fifth vertex.
      await dragOnMap(page, [-6.2005, 106.8315], 0, 20);
      await page.locator(".leaflet-draw-actions a").filter({ hasText: "Simpan" }).click();

      await expectZoneRejected(page, "Poligon terlalu detail");
      await expectBridgeScenario(page);
    });

    test("a valid edit after a rejected edit reshapes the restored zone", async ({ page }) => {
      await loadFixtureMap(page, { ...mode, maxPolygonVertices: 4 });
      await drawPolygon(page, RING);
      await page.locator(".leaflet-draw-edit-edit").click();
      await dragOnMap(page, [-6.2005, 106.8315], 0, 20);
      await page.locator(".leaflet-draw-actions a").filter({ hasText: "Simpan" }).click();
      await expectZoneRejected(page, "Poligon terlalu detail");

      await page.locator(".leaflet-draw-edit-edit").click();
      await dragOnMap(page, [-6.1995, 106.8318], 0, -30);
      await page.locator(".leaflet-draw-actions a").filter({ hasText: "Simpan" }).click();

      await expectZoneAccepted(page);
      const [zone] = await scenarioPolygons(page);
      expect(zone.vertices).toBe(4);
      expect(zone.north).toBeGreaterThan(-6.1995);
    });

    test("undo after a rejected polygon restores the zone it replaced", async ({ page }) => {
      await loadFixtureMap(page, mode);
      await drawPolygon(page, RING);
      await expectBridgeScenario(page);
      await drawPolygon(page, NORTH_RING);
      await expect(page.locator("#afterCount")).toHaveText("5");
      await expect(page.locator("#undoPolygon")).toBeVisible();

      await drawTinyPolygon(page);
      await expectZoneRejected(page, "Zona terlalu kecil");
      await expect(page.locator("#afterCount")).toHaveText("5");
      await expect(page.locator("#undoPolygon")).toBeVisible();

      await page.locator("#undoPolygon").click();
      await expectZoneAccepted(page);
      await expectBridgeScenario(page);
    });

    test("clearing after a rejected polygon returns to the baseline", async ({ page }) => {
      await loadFixtureMap(page, mode);
      await drawPolygon(page, RING);
      await drawTinyPolygon(page);
      await expectZoneRejected(page, "Zona terlalu kecil");

      await page.getByRole("tab", { name: "Skenario" }).click();
      await page.locator("#clearButton").click();

      await expectZoneAccepted(page);
      await expectBaseline(page);
    });

    test("a valid polygon after a rejected one becomes the scenario", async ({ page }) => {
      await loadFixtureMap(page, mode);
      await drawTinyPolygon(page);
      await expectZoneRejected(page, "Zona terlalu kecil");

      await drawPolygon(page, RING);

      await expectZoneAccepted(page);
      await expectBridgeScenario(page);
    });
  });
}
