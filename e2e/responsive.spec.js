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

async function targetSize(locator) {
  const box = await locator.boundingBox();
  expect.soft(box.width, `${await locator.evaluate((el) => el.id || el.className)} width`).toBeGreaterThanOrEqual(44);
  expect.soft(box.height, `${await locator.evaluate((el) => el.id || el.className)} height`).toBeGreaterThanOrEqual(44);
}

async function visibleFocus(locator) {
  await expect(locator).toBeFocused();
  await expect(locator).toBeInViewport({ ratio: 1 });
  expect(await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return el.matches(":focus-visible") && style.outlineStyle !== "none" &&
      parseFloat(style.outlineWidth) >= 2 &&
      el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
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
        const surfaces = await page.locator(".map-empty:visible, .map-error:visible, .map-legend:visible, .map-instruction:visible, .leaflet-control-zoom:visible, .leaflet-draw-toolbar:visible, .leaflet-control-scale:visible, .leaflet-control-attribution:visible").evaluateAll((elements) => elements.map((el) => ({
          name: el.className,
          box: el.getBoundingClientRect().toJSON(),
        })));
        for (let i = 0; i < surfaces.length; i++) {
          for (const other of surfaces.slice(i + 1)) {
            const { box, name } = surfaces[i];
            const overlap = Math.min(box.right, other.box.right) > Math.max(box.left, other.box.left) &&
              Math.min(box.bottom, other.box.bottom) > Math.max(box.top, other.box.top);
            expect.soft(overlap, `${name} overlaps ${other.name}`).toBe(false);
          }
        }
        if (process.env.RESPONSIVE_SCREENSHOTS) {
          await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/${layout.name}-${state}.png` });
        }
      });

      test(`${state}: controls have real 44px targets`, async ({ page }) => {
        await enterState(page, state);
        for (const control of await page.locator(".leaflet-control-zoom a:visible, .leaflet-draw-toolbar a:visible, .leaflet-draw-actions a:visible, #retryButton:visible").all()) {
          await targetSize(control);
        }
        for (const name of ["Data", "Skenario", "Dampak"]) {
          const tab = page.getByRole("tab", { name, exact: true });
          await targetSize(tab);
          await tab.click();
          for (const control of await page.locator(".panel-section button:visible, .panel-section input:visible").all()) {
            await targetSize(control);
          }
        }
      });
    }

    test("tabs and scenario controls retain visible keyboard focus", async ({ page }) => {
      await enterState(page, "baseline");
      const data = page.getByRole("tab", { name: "Data", exact: true });
      for (let i = 0; i < 30 && !(await data.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press("Tab");
      }
      await visibleFocus(data);
      for (const [key, name] of [["ArrowRight", "Skenario"], ["ArrowRight", "Dampak"], ["ArrowRight", "Data"], ["ArrowLeft", "Dampak"], ["Home", "Data"], ["End", "Dampak"], ["ArrowLeft", "Skenario"]]) {
        await page.keyboard.press(key);
        const tab = page.getByRole("tab", { name, exact: true });
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await visibleFocus(tab);
      }
      for (const id of ["originLat", "originLon", "setOriginButton", "applyButton", "clearButton", "fitButton"]) {
        await page.keyboard.press("Tab");
        await visibleFocus(page.locator(`#${id}`));
      }
    });
  });
}
