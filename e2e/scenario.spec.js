import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const overpassFixture = readFileSync(
  new URL("../tests/fixtures/overpass_synthetic.json", import.meta.url),
  "utf8",
);
const floodFixture = readFileSync(
  new URL("../tests/fixtures/flood.png", import.meta.url),
);

const RING = [
  [-6.1995, 106.8312],
  [-6.2005, 106.8312],
  [-6.2005, 106.8318],
  [-6.1995, 106.8318],
];

test("scenario closes the bridge and reduces health access", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/interpreter**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: overpassFixture,
    }),
  );
  await page.route("**/MapServer/export**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );
  await page.route(/https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );

  await page.goto("/");
  await page.locator("#loadButton").click();

  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await expect(page.locator("#afterCount")).toHaveText("5");
  await expect(page.locator("#beforeDistance")).toHaveText("0.3 km");

  await page.waitForTimeout(1200);
  await page.evaluate(() => map.setView([-6.2, 106.8315], 16, { animate: false }));
  await expect.poll(() => page.evaluate(() => map.getZoom())).toBe(16);
  await expect.poll(() => page.evaluate(() => map.getCenter().lng)).toBeCloseTo(
    106.8315,
    4,
  );

  await page.locator(".leaflet-draw-draw-polygon").click();
  await expect(page.locator("#mapInstructions span")).toContainText(
    "Klik beberapa titik",
  );

  const mapBox = await page.locator("#map").boundingBox();
  const points = await page.evaluate((ring) => {
    return ring.map(([lat, lng]) => {
      const point = map.latLngToContainerPoint([lat, lng]);
      return { x: point.x, y: point.y };
    });
  }, RING);

  for (const point of points) {
    await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);
    await page.waitForTimeout(350);
  }
  await page.locator(".leaflet-draw-actions a").filter({ hasText: "Finish" }).click();

  await expect(page.locator("#afterCount")).toHaveText("3");
  await expect(page.locator("#afterDistance")).toHaveText("0.6 km");
  await expect(page.locator("#resultNote")).toContainText(
    "segmen jalan masuk zona",
  );
  await expect(page.locator("#facilityList .facility-row")).toHaveCount(3);
  expect(pageErrors).toEqual([]);
});
