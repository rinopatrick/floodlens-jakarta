# FloodLens UI — Civic Atlas Redesign

## Direction

Keep the existing civic-atlas identity and make the workspace map-first, editorial, and operationally legible. This is a tool interface, not a marketing page.

Reference concept: OpenDesign project `floodlens-civic-atlas-redesign` (`floodlens-civic-atlas.html`, 2026-10-21). The implementation in `public/` is the source of truth.

## Principles

- The map is the primary surface; the inspector is a narrow working rail.
- Workflow is numbered: 01 Basis data, 02 Skenario, 03 Perubahan jangkauan.
- Real data labels, not decorative charts. No fake metrics, stock photos, emoji icons, gradient hero, glassmorphism, or card grid.
- Hairline rules, flat surfaces, zero radius, restrained rust and teal.
- Dense enough for analysis, calm enough for a public-interest portfolio.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#e9ede7` | Paper / map surround |
| `--surface` | `#f8f6ef` | Inspector, controls, legend |
| `--fg` | `#1f373d` | Ink |
| `--muted` | `#5c7274` | Secondary copy |
| `--border` | `#cbd4ca` | Hairline |
| `--accent` | `#28776f` | Route, primary action, active state |
| `--rust` | `#b2513c` | Closed segments, hazard, warnings |
| `--hazard-low/mid/high/max` | green → yellow → orange → red | BNPB reference scale |

Type: Fraunces (display), IBM Plex Sans (body), IBM Plex Mono (labels, coordinates, distances). Spacing follows 4 / 8 / 12 / 16 / 24 / 32. Border radius is zero except circular map markers.

## Layout

Desktop:

- 72px topbar, 44px state strip, then a two-column workspace.
- Map fills the remaining width; inspector is 380px (350px under 1050px).
- Map chrome: draw toolbar top-left, zoom top-right, hazard badge, legend bottom-left, instruction bottom-right.
- Inspector sections remain visible together; the panel scrolls.

Mobile (≤720px):

- Map stays above the inspector at 42% viewport height.
- Inspector becomes a bottom sheet with Data / Skenario / Dampak tabs.
- Legend and instruction stack at the bottom of the map.
- Empty state hides the draw toolbar, legend, instruction, and hazard badge so the load action is unambiguous.
- All controls keep 44px minimum targets.

## States

- `empty`: no OSM data; map invitation + load button.
- `baseline`: OSM loaded, no polygon; baseline metrics and routes.
- `drawing`: polygon tool active; closure and scenario routes hidden.
- `result`: polygon applied; closure segments, scenario route, comparative metrics.
- `error`: upstream failure; error panel and retry action.

The state is applied to `#app[data-state]`; the strip reflects the active state. The inspector tabs are independent on mobile.

## Implementation notes

- Leaflet remains the real map engine. The OpenDesign concept's static map image and SVG routes were not copied.
- Leaflet.draw icons are rendered from the vendored PNG spritesheet through centered pseudo-elements; the previous `background` shorthand was overriding the sprite.
- OSM tiles receive a restrained grayscale/sepia filter; the BNPB overlay uses multiply blending and is hidden in empty/error states.
- Routes use the existing `--baseline` / `--teal` aliases; closed segments use `--coral` / `--rust`.
- Facility rows are `<li>` elements with numbered index, name, and scenario distance.
- The map attribution control is disabled; attribution is kept in the legend and the README.

## Verification

```text
python -m pytest -q       43 passed
python -m ruff check .    clean
npm test                  13 passed
npx playwright test       1 passed
```

E2E fixes the same synthetic bridge scenario: 5 reachable facilities baseline, 3 after closure, nearest hospital 0.3 → 0.6 km, detour +224 m.
