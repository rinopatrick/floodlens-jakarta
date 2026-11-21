import { readFileSync } from "node:fs";

export function largeRoadFixture() {
  const data = JSON.parse(readFileSync(new URL("../tests/fixtures/osm_simplified.json", import.meta.url)));
  const add = (id, lat, lon) => data.roads.push({
    id, kind: "residential", oneway: "no",
    points: [{ id: `${id}-a`, lat, lon }, { id: `${id}-b`, lat, lon: lon + .00015 }],
  });
  for (let i = 0; i < 19790; i++) {
    add(`grid-${i}`, -6.259 + Math.floor(i / 180) * .00108, 106.781 + (i % 180) * .0006);
  }
  for (let i = 0; i < 200; i++) add(`local-${i}`, -6.2002 + i * .000002, 106.8301);
  data.bounds = { south: -6.26, west: 106.78, north: -6.14, east: 106.89 };
  return data;
}
