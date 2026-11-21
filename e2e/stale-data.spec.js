import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const floodFixture = readFileSync(
  new URL("../tests/fixtures/flood.png", import.meta.url),
);

const STALE_COPY = "Pembaruan dari OpenStreetMap gagal";

// Serve the real fixture body, overriding only the staleness headers.
async function routeOsm(page, headersFor) {
  await page.route(/https:\/\/server\.arcgisonline\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: floodFixture }),
  );
  await page.route("**/api/osm**", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["x-data-stale"];
    delete headers["x-data-age"];
    await route.fulfill({ response, headers: { ...headers, ...headersFor() } });
  });
}

function staleNotice(page) {
  return page.getByRole("status").filter({ hasText: STALE_COPY });
}

test("stale OSM data shows an accessible notice with its age", async ({ page }) => {
  await routeOsm(page, () => ({ "x-data-stale": "1", "x-data-age": "10800" }));
  await page.goto("/");
  await page.locator("#loadButton").click();

  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  const notice = staleNotice(page);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("aria-live", "polite");
  await expect(notice).toContainText("± 3 jam lalu");
  await expect(page.locator("#connectionText")).not.toContainText("siap digunakan");
  await expect(page.locator("#connectionText")).toContainText("cache");

  // Stale fallback data stays usable for routes and metrics.
  await expect(page.locator("#beforeCount")).toHaveText("5");
  await expect(page.locator("#beforeDistance")).toHaveText("332 m");
});

test("fresh OSM data shows no stale notice", async ({ page }) => {
  await routeOsm(page, () => ({ "x-data-age": "30" }));
  await page.goto("/");
  await page.locator("#loadButton").click();

  await expect(page.locator("#osmState")).toHaveText("10 RUAS");
  await expect(page.locator("#connectionText")).toContainText("siap digunakan");
  await expect(page.locator("#staleNotice")).toBeHidden();
});

for (const [label, extra] of [
  ["absent", {}],
  ["invalid", { "x-data-age": "abc" }],
  ["negative", { "x-data-age": "-5" }],
]) {
  test(`stale OSM data with ${label} age shows the notice without an age`, async ({ page }) => {
    await routeOsm(page, () => ({ "x-data-stale": "1", ...extra }));
    await page.goto("/");
    await page.locator("#loadButton").click();

    await expect(page.locator("#osmState")).toHaveText("10 RUAS");
    const notice = staleNotice(page);
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText("lalu");
    await expect(notice).not.toContainText("±");
  });
}

test("a fresh reload after stale data clears the notice", async ({ page }) => {
  let stale = true;
  await routeOsm(page, () =>
    stale ? { "x-data-stale": "1", "x-data-age": "7200" } : { "x-data-age": "0" },
  );
  await page.goto("/");
  await page.locator("#loadButton").click();
  await expect(staleNotice(page)).toBeVisible();

  stale = false;
  await page.locator("#loadButton").click();
  await expect(page.locator("#connectionText")).toContainText("siap digunakan");
  await expect(page.locator("#staleNotice")).toBeHidden();
  await expect(page.locator("#beforeCount")).toHaveText("5");
});
