import assert from "node:assert/strict";
import test from "node:test";

import { distanceMeters, formatKm, isInsideBounds, pointInPolygon } from "../../public/src/geo.js";

test("distanceMeters matches a known latitude step", () => {
  const distance = distanceMeters(
    { lat: -6.2, lon: 106.83 },
    { lat: -6.199, lon: 106.83 },
  );

  assert.ok(Math.abs(distance - 111.19) < 0.5, String(distance));
});

test("formatKm uses meters under 1 km and km above", () => {
  assert.equal(formatKm(56), "56 m");
  assert.equal(formatKm(331.8), "332 m");
  assert.equal(formatKm(1500), "1.5 km");
});

test("isInsideBounds rejects clicks outside the pilot box", () => {
  const bounds = { south: -6.26, west: 106.78, north: -6.14, east: 106.89 };

  assert.equal(isInsideBounds(-6.2, 106.83, bounds), true);
  assert.equal(isInsideBounds(-6.3, 106.83, bounds), false);
  assert.equal(isInsideBounds(-6.2, 106.95, bounds), false);
  assert.equal(isInsideBounds(Number.NaN, 106.83, bounds), false);
  assert.equal(isInsideBounds(-6.2, 106.83, null), false);
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
