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
