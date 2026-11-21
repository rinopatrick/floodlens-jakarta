import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const tile = readFileSync(new URL("../tests/fixtures/flood.png", import.meta.url));
const layouts = [
  { name: "portrait", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
];

test("short mobile error keeps inspector controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 540 });
  await enterState(page, "error");
  for (const name of ["Data", "Skenario", "Dampak"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await expect(tab).toBeInViewport({ ratio: 1 });
    await tab.click();
  }
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  const load = page.locator("#loadButton");
  await load.scrollIntoViewIfNeeded({ timeout: 1000 });
  await expect(load).toBeInViewport({ ratio: 1, timeout: 1000 });
  await load.click({ trial: true, timeout: 1000 });
  await page.getByRole("tab", { name: "Skenario", exact: true }).click();
  for (const id of ["originLat", "originLon", "setOriginButton", "fitButton"]) {
    const control = page.locator(`#${id}`);
    await control.scrollIntoViewIfNeeded({ timeout: 1000 });
    await expect(control).toBeInViewport({ ratio: 1, timeout: 1000 });
    await control.click({ trial: true, timeout: 1000 });
  }
  if (process.env.RESPONSIVE_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/short-mobile-error.png` });
  }
});

async function enterState(page, state, { bnpb = false } = {}) {
  if (bnpb) {
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), fixtureMode: false } });
    });
    await page.route("**/api/flood", (route) => route.fulfill({ contentType: "image/png", body: tile }));
  }
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

for (const height of [844, 824]) {
  test(`BNPB result leaves map controls hittable at 390x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height });
    await enterState(page, "result", { bnpb: true });
    await expect(page.locator(".hazard-block")).toBeVisible();
    for (const control of await page.locator(".leaflet-draw-toolbar a, .leaflet-control-zoom a").all()) {
      expect.soft(await control.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), await control.getAttribute("title")).toBe(true);
    }
    if (height === 844 && process.env.RESPONSIVE_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/portrait-result-bnpb.png` });
    }
  });
}

for (const state of ["empty", "error"]) {
  test(`live landscape ${state} keeps BNPB badge clear of fixed surfaces`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await enterState(page, state, { bnpb: true });
    const badge = page.locator(".hazard-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toBeInViewport({ ratio: 1 });
    const overlap = await badge.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...document.querySelectorAll(".map-empty, .map-error, .map-legend, .map-instruction, .leaflet-control-zoom, .leaflet-draw-toolbar, .leaflet-control-scale, .leaflet-control-attribution")].some((surface) => {
        const other = surface.getBoundingClientRect();
        return Math.min(box.right, other.right) > Math.max(box.left, other.left) &&
          Math.min(box.bottom, other.bottom) > Math.max(box.top, other.top);
      });
    });
    expect(overlap).toBe(false);
    if (process.env.RESPONSIVE_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/landscape-${state}-bnpb.png` });
    }
  });
}

for (const state of ["baseline", "result", "error"]) {
  test(`narrow BNPB ${state} leaves fixed map controls hittable`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await enterState(page, state, { bnpb: true });
    await expect(page.locator(".hazard-block")).toBeVisible();
    await expect(page.locator(".map-legend")).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".leaflet-control-attribution")).toBeInViewport({ ratio: 1 });
    for (const control of await page.locator(".leaflet-draw-toolbar a, .leaflet-control-zoom a, #retryButton:visible").all()) {
      expect.soft(await control.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), await control.getAttribute("title") || await control.textContent()).toBe(true);
    }
    const surfaces = await page.locator(".map-error:visible, .map-legend:visible, .map-instruction:visible, .leaflet-control-zoom:visible, .leaflet-draw-toolbar:visible, .leaflet-control-attribution:visible").evaluateAll((elements) => elements.map((el) => ({
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
      await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/${state === "result" ? "320x568-bnpb" : `320x568-${state}-bnpb`}.png` });
    }
    await page.getByRole("tab", { name: "Skenario", exact: true }).click();
    const input = page.locator("#originLat");
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport({ ratio: 1 });
    await input.click();
    await expect(input).toBeFocused();
  });
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

    test("dragging a corner moves that vertex without inserting one", async ({ page }) => {
      await enterState(page, "result");
      await page.evaluate(() => window.floodlensMap.panBy([-65, 50], { animate: false }));
      await page.locator(".leaflet-draw-edit-edit").click();
      const vertices = () => page.evaluate(() => {
        const map = window.floodlensMap;
        let polygon;
        map.eachLayer((layer) => {
          if (layer instanceof window.L.Polygon && layer.editing?.enabled()) polygon = layer;
        });
        return polygon.getLatLngs()[0].map((latlng) => {
          const point = map.latLngToContainerPoint(latlng);
          return { x: point.x, y: point.y };
        });
      });
      const before = await vertices();
      expect(before).toHaveLength(4);
      const box = await page.locator("#map").boundingBox();
      const start = { x: box.x + before[0].x, y: box.y + before[0].y };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 30, start.y - 20, { steps: 10 });
      await page.mouse.up();
      const after = await vertices();
      expect(after).toHaveLength(4);
      expect(after[0].x).toBeCloseTo(before[0].x + 30, 0);
      expect(after[0].y).toBeCloseTo(before[0].y - 20, 0);
      expect(after.slice(1)).toEqual(before.slice(1));
      for (const handle of await page.locator(".leaflet-marker-draggable").all()) await targetSize(handle);
      if (process.env.RESPONSIVE_SCREENSHOTS) {
        await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/${layout.name}-corner-drag.png` });
      }
      const midpoint = { x: (after[1].x + after[2].x) / 2, y: (after[1].y + after[2].y) / 2 };
      await page.mouse.move(box.x + midpoint.x, box.y + midpoint.y);
      await page.mouse.down();
      await page.mouse.move(box.x + midpoint.x + 10, box.y + midpoint.y + 10, { steps: 10 });
      await page.mouse.up();
      const expanded = await vertices();
      expect(expanded).toHaveLength(5);
      expect(expanded[2].x).toBeCloseTo(midpoint.x + 10, 0);
      expect(expanded[2].y).toBeCloseTo(midpoint.y + 10, 0);
      expect(expanded.filter((_, index) => index !== 2)).toEqual(after);
    });

    test("map marker and polygon edit targets are at least 44px", async ({ page }) => {
      await enterState(page, "result");
      await expect(page.locator(".health-pin").first()).toBeAttached();
      for (const marker of await page.locator(".leaflet-marker-icon:has(.health-pin), .leaflet-marker-icon:has(.origin-pin)").all()) {
        await targetSize(marker);
      }
      await page.locator(".leaflet-draw-edit-edit").click();
      const handles = page.locator(".leaflet-marker-draggable");
      await expect(handles.first()).toBeAttached();
      for (const handle of await handles.all()) await targetSize(handle);
      await page.evaluate(() => window.floodlensMap.setZoom(14, { animate: false }));
      const clusters = page.locator(".facility-cluster-icon");
      await expect(clusters.first()).toBeAttached();
      for (const cluster of await clusters.all()) await targetSize(cluster);
    });

    test("loading cancel has a 44px target and visible keyboard focus", async ({ page }) => {
      await enterState(page, "empty");
      await page.route("**/api/osm**", () => {});
      await page.locator("#loadButton").click();
      const cancel = page.locator("#cancelLoad");
      await expect(cancel).toBeVisible();
      await targetSize(cancel);
      for (let i = 0; i < 30 && !(await cancel.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press("Tab");
      }
      await visibleFocus(cancel);
      await page.keyboard.press("Enter");
      await expect(cancel).toBeHidden();
      await expect(page.locator("#loadButton")).toBeEnabled();
    });

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
        const surfaces = await page.locator(".hazard-badge:visible, .map-empty:visible, .map-error:visible, .map-legend:visible, .map-instruction:visible, .leaflet-control-zoom:visible, .leaflet-draw-toolbar:visible, .leaflet-control-scale:visible, .leaflet-control-attribution:visible").evaluateAll((elements) => elements.map((el) => ({
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
