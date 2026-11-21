import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const image = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
});

test("hazard overlay uses server flood bounds in Leaflet order", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ json: {
    fixtureMode: false,
    floodBounds: { south: -6.32, west: 106.72, north: -6.08, east: 106.95 },
  } }));
  await page.goto("/");
  await expect(page.locator(".hazard-overlay")).toBeAttached();
  const bounds = await page.evaluate(() => {
    const layers = Object.values(window.floodlensMap._layers);
    const overlay = layers.find((layer) => layer instanceof L.ImageOverlay);
    const extent = overlay.getBounds();
    return [[extent.getSouth(), extent.getWest()], [extent.getNorth(), extent.getEast()]];
  });
  expect(bounds).toEqual([[-6.32, 106.72], [-6.08, 106.95]]);
});

for (const [name, floodBounds] of [
  ["missing", undefined],
  ["null", null],
  ["incomplete", { south: -6.31 }],
  ["string", { south: "-6.31", west: 106.73, north: -6.09, east: 106.94 }],
  ["reversed", { south: -6.09, west: 106.73, north: -6.31, east: 106.94 }],
  ["out of range", { south: -96, west: 106.73, north: -6.09, east: 106.94 }],
  ["zero width", { south: -6.31, west: 106.73, north: -6.09, east: 106.73 }],
  ["failed request", undefined],
]) {
  test(`${name} flood bounds disable hazard without breaking roads`, async ({ page }) => {
    const errors = [];
    const floodRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/flood") floodRequests.push(request.url());
    });
    await page.route("**/api/config", (route) => name === "failed request"
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.fulfill({ json: { fixtureMode: true, floodBounds } }));
    await page.goto("/");
    await expect(page.locator("#bnpbState")).toHaveText("TIDAK TERSEDIA");
    await expect(page.locator("#hazardToggle")).toBeDisabled();
    await expect(page.locator(".hazard-overlay")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Object.values(window.floodlensMap._layers)
      .filter((layer) => layer instanceof L.ImageOverlay).length)).toBe(0);
    await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
    await page.locator("#loadButton").click();
    await expect(page.locator("#osmState")).toHaveText("10 RUAS");
    await expect(page.locator("#beforeCount")).toHaveText("5");
    await expect(page.locator("#afterCount")).toHaveText("5");
    expect(floodRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
