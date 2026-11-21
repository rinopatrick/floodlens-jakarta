import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const tile = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));
const layouts = [
  { name: "portrait", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
];

async function enterState(page, state) {
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: tile }),
  );
  if (state === "error") {
    await page.route("**/api/osm**", (route) => route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "upstream_unavailable", message: "Sumber data OpenStreetMap tidak tersedia." } }),
    }));
  }
  await page.goto("/");
  if (state !== "empty") await page.locator("#loadButton").click();
  if (["baseline", "drawing", "result"].includes(state)) {
    await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  }
  if (["drawing", "result"].includes(state)) {
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.floodlensMap.setView([-6.2, 106.8315], 16, { animate: false }));
    await page.locator(".leaflet-draw-draw-polygon").click();
  }
  if (state === "result") {
    const box = await page.locator("#map").boundingBox();
    const points = await page.evaluate(() => [
      [-6.1995, 106.8312], [-6.2005, 106.8312],
      [-6.2005, 106.8318], [-6.1995, 106.8318],
    ].map((latlng) => window.floodlensMap.latLngToContainerPoint(latlng)));
    for (const point of points) {
      await page.mouse.click(box.x + point.x, box.y + point.y);
      await page.waitForTimeout(350);
    }
    await page.locator(".leaflet-draw-actions a").filter({ hasText: "Selesai" }).click();
    await expect(page.locator("#afterCount")).toHaveText("3");
  }
  await expect(page.locator("#app")).toHaveAttribute("data-state", state);
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: { width: layout.width, height: layout.height } });

    for (const state of ["empty", "baseline", "drawing", "result", "error"]) {
      test(`${state}: basemap credits stay in view independently of legend`, async ({ page }) => {
        await enterState(page, state);
        if (layout.name === "landscape" || ["empty", "drawing"].includes(state)) {
          await expect(page.locator(".map-legend")).toBeHidden();
        }
        const credits = page.locator(".leaflet-control-attribution");
        await expect(credits).toBeVisible({ timeout: 1000 });
        await expect(credits).toContainText("Esri");
        await expect(credits).toContainText("HERE, Garmin");
        await expect(credits).toContainText("OpenStreetMap contributors");
        await expect(credits).toBeInViewport({ ratio: 1 });
      });
    }
  });
}
