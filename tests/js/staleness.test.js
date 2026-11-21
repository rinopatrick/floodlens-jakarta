import assert from "node:assert/strict";
import test from "node:test";

import { describeStaleNotice, formatDataAge, loadStatus, osmRequestCache, readStaleness } from "../../public/src/staleness.js";

const headers = (values) => new Headers(values);

test("readStaleness reports fresh data when X-Data-Stale is absent", () => {
  assert.deepEqual(readStaleness(headers({ "X-Data-Age": "120" })), { stale: false, ageSeconds: 120 });
});

test("readStaleness reports stale data with its age", () => {
  assert.deepEqual(
    readStaleness(headers({ "X-Data-Stale": "1", "X-Data-Age": "10800" })),
    { stale: true, ageSeconds: 10800 },
  );
});

test("readStaleness treats missing, empty, negative or non-numeric age as unknown", () => {
  for (const age of [undefined, "", "-5", "abc", "1.5", "12s"]) {
    const values = { "X-Data-Stale": "1" };
    if (age !== undefined) values["X-Data-Age"] = age;
    assert.deepEqual(readStaleness(headers(values)), { stale: true, ageSeconds: null }, String(age));
  }
});

test("readStaleness only treats X-Data-Stale: 1 as stale", () => {
  assert.equal(readStaleness(headers({ "X-Data-Stale": "0" })).stale, false);
  assert.equal(readStaleness(headers({ "X-Data-Stale": "true" })).stale, false);
});

test("formatDataAge gives a human-readable Indonesian age", () => {
  assert.equal(formatDataAge(0), "kurang dari 1 menit lalu");
  assert.equal(formatDataAge(59), "kurang dari 1 menit lalu");
  assert.equal(formatDataAge(60), "± 1 menit lalu");
  assert.equal(formatDataAge(3599), "± 59 menit lalu");
  assert.equal(formatDataAge(10800), "± 3 jam lalu");
  assert.equal(formatDataAge(86399), "± 23 jam lalu");
  assert.equal(formatDataAge(2 * 86400 + 5), "± 2 hari lalu");
});

test("formatDataAge returns null for an unknown age", () => {
  assert.equal(formatDataAge(null), null);
});

test("describeStaleNotice says refresh failed and includes the age when known", () => {
  assert.equal(
    describeStaleNotice(10800),
    "Pembaruan dari OpenStreetMap gagal. Menampilkan data cache terakhir (± 3 jam lalu).",
  );
  assert.equal(
    describeStaleNotice(null),
    "Pembaruan dari OpenStreetMap gagal. Menampilkan data cache terakhir.",
  );
});

test("osmRequestCache always revalidates normal loads and bypasses the cache on refresh", () => {
  assert.equal(osmRequestCache(false), "no-cache");
  assert.equal(osmRequestCache(true), "no-store");
});

test("loadStatus keeps a refresh cooldown visible over the ready and stale copy", () => {
  assert.deepEqual(loadStatus({ stale: false, cooldownWait: "24", fixture: false }),
    { text: "Refresh dibatasi, coba lagi dalam 24 dtk", state: "live" });
  assert.deepEqual(loadStatus({ stale: true, cooldownWait: "5", fixture: false }),
    { text: "Refresh dibatasi, coba lagi dalam 5 dtk", state: "stale" });
});

test("loadStatus reports stale, live and fixture data without a cooldown", () => {
  assert.deepEqual(loadStatus({ stale: true, cooldownWait: null, fixture: false }),
    { text: "Memakai data cache, pembaruan gagal", state: "stale" });
  assert.deepEqual(loadStatus({ stale: false, cooldownWait: null, fixture: false }),
    { text: "Data publik siap digunakan", state: "live" });
  assert.deepEqual(loadStatus({ stale: false, cooldownWait: null, fixture: true }),
    { text: "Data contoh siap digunakan", state: "live" });
});
