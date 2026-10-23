import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const floodFixture = readFileSync(
  new URL("../tests/fixtures/flood.png", import.meta.url),
);

const RING = [
  [-6.1995, 106.8312],
  [-6.2005, 106.8312],
  [-6.2005, 106.8318],
  [-6.1995, 106.8318],
];

// A ring that overlaps no road midpoint, so it closes nothing.
const NORTH_RING = [
  [-6.1986, 106.8308],
  [-6.1992, 106.8308],
  [-6.1992, 106.832],
  [-6.1986, 106.832],
];

async function loadFixtureMap(page) {
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );
  await page.goto("/");
  await page.locator("#loadButton").click();
  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  await page.waitForTimeout(1200);
  await page.evaluate(() =>
    window.floodlensMap.setView([-6.2, 106.8315], 16, { animate: false }),
  );
  await expect
    .poll(() => page.evaluate(() => window.floodlensMap.getZoom()))
    .toBe(16);
}

async function drawPolygon(page, ring) {
  await page.locator(".leaflet-draw-draw-polygon").click();
  const mapBox = await page.locator("#map").boundingBox();
  const points = await page.evaluate((r) => {
    return r.map(([lat, lng]) => {
      const point = window.floodlensMap.latLngToContainerPoint([lat, lng]);
      return { x: point.x, y: point.y };
    });
  }, ring);
  for (const point of points) {
    await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);
    await page.waitForTimeout(350);
  }
  await page.locator(".leaflet-draw-actions a").filter({ hasText: "Selesai" }).click();
}

test("scenario closes the bridge and reduces health access", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    const allowed =
      url.origin === "http://127.0.0.1:8767" ||
      url.hostname.endsWith("server.arcgisonline.com");
    if (!allowed) externalRequests.push(request.url());
  });

  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );

  await page.goto("/");
  await page.locator("#loadButton").click();

  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await expect(page.locator("#afterCount")).toHaveText("5");
  await expect(page.locator("#beforeDistance")).toHaveText("332 m");

  await page.waitForTimeout(1200);
  await page.evaluate(() =>
    window.floodlensMap.setView([-6.2, 106.8315], 16, { animate: false }),
  );
  await expect.poll(() => page.evaluate(() => window.floodlensMap.getZoom())).toBe(16);
  await expect
    .poll(() => page.evaluate(() => window.floodlensMap.getCenter().lng))
    .toBeCloseTo(106.8315, 4);

  await page.locator(".leaflet-draw-draw-polygon").click();
  await expect(page.locator("#instructionCopy")).toContainText(
    "Klik beberapa titik",
  );

  const mapBox = await page.locator("#map").boundingBox();
  const points = await page.evaluate((ring) => {
    return ring.map(([lat, lng]) => {
      const point = window.floodlensMap.latLngToContainerPoint([lat, lng]);
      return { x: point.x, y: point.y };
    });
  }, RING);

  for (const point of points) {
    await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);
    await page.waitForTimeout(350);
  }
  await page.locator(".leaflet-draw-actions a").filter({ hasText: "Selesai" }).click();

  await expect(page.locator("#afterCount")).toHaveText("3");
  await expect(page.locator("#afterDistance")).toHaveText("556 m");
  await expect(page.locator("#resultNote")).toContainText(
    "segmen jalan masuk zona",
  );
  await expect(page.locator("#facilityList .facility-row")).toHaveCount(3);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test("a second zone offers a non-blocking undo", async ({ page }) => {
  await loadFixtureMap(page);

  await drawPolygon(page, RING);
  await expect(page.locator("#afterCount")).toHaveText("3");
  await expect(page.locator("#undoPolygon")).toBeHidden();

  // No dialog appears; a new zone replaces the old one and offers undo.
  await drawPolygon(page, NORTH_RING);
  await expect(page.locator("#afterCount")).toHaveText("5");
  await expect(page.locator("#undoPolygon")).toBeVisible();

  await page.locator("#undoPolygon").click();
  await expect(page.locator("#afterCount")).toHaveText("3");
  await expect(page.locator("#undoPolygon")).toBeHidden();
});

test("fixture mode is labelled honestly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#loadButtonText")).toHaveText("Muat data contoh");
  await expect(page.locator("#bnpbState")).toHaveText("FIXTURE · NONAKTIF");
  await expect(page.locator(".fixture-note")).toBeVisible();
  await expect(page.locator("#hazardToggle")).toBeDisabled();
});

test("error state exposes a retry action", async ({ page }) => {
  await page.route("**/api/osm**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "upstream_unavailable",
          message: "Sumber data OpenStreetMap tidak tersedia.",
        },
      }),
    }),
  );

  await page.goto("/");
  await page.click("#loadButton");

  await expect(page.locator("#app")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#mapError")).toBeVisible();
  await expect(page.locator("#retryButton")).toBeVisible();
  await expect(page.locator("#mapErrorText")).toContainText(
    "Sumber data OpenStreetMap",
  );
});

test("inspector tabs support arrow keys", async ({ page }) => {
  await page.goto("/");
  const scenarioTab = page.getByRole("tab", { name: "Skenario" });
  await scenarioTab.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page.getByRole("tab", { name: "Dampak" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("draw toolbar is keyboard operable", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(600);
  await page.locator(".leaflet-draw-draw-polygon").focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("#app")).toHaveAttribute("data-state", "drawing");
});
