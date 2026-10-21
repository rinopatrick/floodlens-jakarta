import assert from "node:assert/strict";
import test from "node:test";

import { distanceMeters, formatKm, pointInPolygon } from "../../public/src/geo.js";

test("distanceMeters matches a known latitude step", () => {
  const distance = distanceMeters(
    { lat: -6.2, lon: 106.83 },
    { lat: -6.199, lon: 106.83 },
  );

  assert.ok(Math.abs(distance - 111.19) < 0.5, String(distance));
});

test("formatKm uses one decimal place", () => {
  assert.equal(formatKm(331.8), "0.3 km");
  assert.equal(formatKm(556), "0.6 km");
});

test("pointInPolygon detects inside and outside", () => {
  const ring = [
    { lat: -6.1995, lng: 106.8312 },
    { lat: -6.2005, lng: 106.8312 },
    { lat: -6.2005, lng: 106.8318 },
    { lat: -6.1995, lng: 106.8318 },
  ];

  assert.equal(pointInPolygon([-6.2, 106.8315], ring), true);
  assert.equal(pointInPolygon([-6.2, 106.833], ring), false);
  assert.equal(pointInPolygon([-6.1994, 106.8315], ring), false);
});

test("pointInPolygon handles a concave ring", () => {
  const ring = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 4 },
    { lat: 2, lng: 2 },
    { lat: 4, lng: 4 },
    { lat: 4, lng: 0 },
  ];

  assert.equal(pointInPolygon([1, 2], ring), true);
  assert.equal(pointInPolygon([3, 2], ring), true);
  assert.equal(pointInPolygon([2, 2.1], ring), false);
});
