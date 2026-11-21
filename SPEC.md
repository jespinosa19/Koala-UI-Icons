# Koala Icons: drawing spec

Every master in `svg/` follows these rules. The ones marked **[lint]** are enforced by
`scripts/icons.mjs lint`, and `build` refuses to run while any icon fails. The rest are checked
by eye on the QA sheet (`/lab/icons`), which renders every icon over its keylines and at 16, 20
and 24 px next to its Phosphor counterpart.

The goal is one hand: 500 icons that read as if one person drew them on one afternoon.

## 1. Canvas

| Rule | Value |
| --- | --- |
| Canvas | 24 × 24, `viewBox="0 0 24 24"` **[lint]** |
| Live area | stroke centerlines stay inside 2 to 22 **[lint]** |
| Ink bound | with the 1.75 stroke, ink stays inside 1.125 to 22.875, never touches the edge |

## 2. Stroke

| Rule | Value |
| --- | --- |
| Width | 1.75, set once on the root, never per element **[lint]**. Chosen on the QA sheet (2026-10-12): more presence than Iconly's 1.5, more air than 2 inside detailed icons |
| Caps / joins | round / round, on the root only **[lint]** |
| Paint | `stroke="currentColor"`, `fill="none"`; no fills (except the dot, §7), no colors, no opacity **[lint]** |
| Outlined shapes | never. Masters are live strokes so the weight stays one value |

Stroke-only means a filled area is drawn as a dot (below) or not at all. The fill style
(selected / status glyphs) is a separate set, drawn later on the same keylines.

## 3. Pixel grid

At 24 px one unit is one pixel. Whole-number positions keep parallel strokes evenly spaced and the
same distance from the edges, so every icon shares one rhythm; with a 1.75 stroke the ink edges do
not land on pixel boundaries at any size, which is the trade for the lighter weight.

- Horizontal and vertical segments sit on **whole numbers** **[lint]**.
- Every other point (diagonal ends, arc ends, centres) sits on the **0.5 grid** **[lint]**.
  Bézier control points are free.
- Diagonals are 45° where the shape allows it. Other angles are deliberate, not drift.

Radial icons (gear, star, sun: 60° or 72° symmetry) cannot land their points on the 0.5 grid. They
carry `"grid": "radial"` in `meta.json`, which skips the 0.5-grid check and nothing else **[lint]**.

16 and 20 px are not whole multiples of 24, so no 24-grid set is pixel-snapped there (Phosphor,
Lucide and Untitled UI included). Sharpness at those sizes comes from the clearance and detail
rules below, verified on the rasterized QA sheet at 1x and 2x.

## 4. Clearance and detail (what keeps 16 px clean)

- **Counter / gap**: two parallel strokes that do not touch keep **4 units** between centrelines,
  so the white gap is at least 2.25 units (1.5 px at 16 px) **[lint, axis-aligned segments]**.
- **Smallest closed shape**: a circle or rounded square has a centreline radius / side of at least
  2 (ink counter at least 2) **[lint for circles: r ≥ 2 unless it is the dot, §7]**.
- **Shortest segment**: 2 units, except a dot.
- **Detail budget**: if a detail disappears or clots at 16 px on the QA sheet, it is removed.
  An icon is a sign, not an illustration.

## 5. Keylines

Optical size, not bounding box: a circle must be drawn bigger than a square to look the same size.
Centreline dimensions:

| Shape | Size | Position |
| --- | --- | --- |
| Circle | Ø 19 | centre 12,12 |
| Square | 18 × 18 | 3,3 to 21,21 |
| Portrait | 16 × 20 | 4,2 to 20,22 |
| Landscape | 20 × 16 | 2,4 to 22,20 |

**Centring**: the ink box sits within 0.5 of the canvas centre, checked by
`node scripts/icons.mjs audit` (which also prints the ink centroid for context). Move a whole
drawing by whole units when it has axis-aligned segments (§3), by 0.5 when it is all diagonals.
The exceptions are deliberate and optical: a play triangle leans right, a chat bubble's tail
pulls its box. The main body of an icon fits one of these. Parts may overshoot by up to 1 unit when they are
pointed (arrows, carets, the tip of a pencil), the same way a typeface's "o" overshoots the
baseline.

Containers moved from L 5 to 4 after comparing with Untitled UI, Tabler and Iconoir (2026-10-12):
still the softest of those sets, less blob-like. The circle is a touch smaller than a full Ø 20 because the soft containers (§6) carry more area
than a sharp square: at Ø 20 circles read about 1 px large at 16 px.

## 6. Corners: soft, from one formula

Koala Icons are rounded. A corner is never a hand-tuned radius: it is a **soft corner**, one cubic
between two tangent points at distance **L** from the vertex, its handles **0.36 L** from the
vertex (a circular arc would be 0.4477 L). The curve starts gently and reads like a squircle, not a
rect with arcs. `scripts/shapes.mjs` draws it (`softRect`, `softPath`); masters come from there so
every corner in the set shares one curvature.

| Corner | L |
| --- | --- |
| Container: card, document, envelope, window, calendar, lock body | 4 |
| Open bracket or tray: sign out, download tray, trash body | 4 |
| Small tile: the squares of a grid | 2 (at 3 a 7-unit tile reads as a circle at 16 px) |
| Vertex of a pointed shape: roof, star point, bolt | 1.5 to 2.6 |
| Stroke ending in a point: arrow, caret, check, X | none, the round join is the softening |

Tangent points sit on the 0.5 grid like every anchor (§3); `softPath` snaps them. On an edge that is
not axis-aligned or 45°, snapping bends the edge slightly: prefer axis-aligned and 45° edges, and on
other slopes pick an L that lands on a grid point of the edge (a 1:2 slope takes L 1.25 or 2.25).
Where a straight edge meets a curve (a bowl's rim, a glass, a scoop), the round join is the
softening, as in Phosphor; no extra corner. `rect` with `rx`
from `{1, 1.5, 2, 3}` stays valid **[lint]** for small parts, but containers use `softRect`.

## 7. Dots

A dot is `<circle cx=".." cy=".." r="1.25" fill="currentColor" stroke="none" />`: a solid Ø 2.5
disc, about 1.4 times the stroke (Phosphor bold's ratio). (A stroked `r="0.5"` circle rasterizes as a ring with a hole in librsvg, so the dot is
filled instead.) One dot size, everywhere: the dot in info and question, the three dots of a
menu, a status pip. It is the only element that carries `fill` or `stroke`, and only with exactly
those values; its centre sits on the 0.5 grid and inside the live area, so its ink may reach 0.5
from the edge **[lint: the dot is exactly that; every other circle is r ≥ 2]**.

## 8. Shape vocabulary

**Character (the owner's brief, 2026-10-12): Phosphor's friendly, slightly playful style, made
rounder, with less detail where Phosphor is busy, and short stubby strokes: the search handle is
short, a stem or a stick is as short as it can be and still read.** Footprints are measured against
Phosphor bold on the QA sheet, so swapping a glyph keeps its size; Iconly, Untitled UI, Tabler and
Iconoir are references too. Remix, never trace.

**Form (the owner, 2026-10-12: "darles algo de forma... con detalle, pero sin pasarse").** An object
is drawn as a thing, not a bare silhouette. Reach for, at most two per icon:
- **Overlap**: parts sit in front of each other (one cherry behind the other: the back shape is an
  arc that stops where it meets the front one, a T-join, never a crossing).
- **A shine**: one short arc inside a round body, upper left, 2 to 3 units long (cherry, egg).
- **Describing marks**: short strokes that start on the edge and stop inside, the carrot's ridges.
- **A pose**: a diagonal or a tilt where the object allows it (the carrot), and an organic part
  where it has one (the cherry leaf).

Marks that clot at 14-16 px are dropped in the small master (§12), not thinned: the shine goes
first, then the second describing mark. In the fill weight shines and marks take the `cut` role.

- **Arrows**: shaft 4 to 20, head a 45° open chevron with arms of 7 (`m13 5 7 7-7 7`). Inside a
  compound icon (sign out, download) the head shrinks to arms of 4 or 5.
- **Carets**: 45° open chevron 14 wide and 7 deep, centred: `m5 8.5 7 7 7-7`.
- **Plus / minus**: arms 4 to 20. **X**: 45° arms, 5 to 19.
- **Check**: both legs 45°, `m4 12 5 5L20 6`; inside a circle `m7.5 12 3 3 6-6`.
- **Bell**: Phosphor's build. The sides lean out gently all the way down from the dome, with no late
  flare at the rim, and the clapper hangs from the rim, as wide as Phosphor's (`M8.5 18a3.5 3.5 0 0 0 7 0`), never floating.
- **Clock**: hands at 12 and 3, `M12 7v5h4`. **Info**: the "i" has a serif and a foot,
  `M10.5 11H12v4.5a1.5 1.5 0 0 0 1.5 1.5`, under a dot at 12,7.5 (detail taken from Phosphor).
- **People**: head a circle (r 3.5 alone, r 3 inside a circle), shoulders one open soft arc
  (`M4.5 20.5c.9-3.2 3.9-5.5 7.5-5.5s6.6 2.3 7.5 5.5` alone). A closed body read as a pill at 16 px.
- **Inner marks float**: the envelope flap, document lines and similar marks stop short of the
  container instead of running into it. Structural parts are not inner marks: a second chat bubble,
  the spokes of share-network, a mark whose meaning is to cross the body (an egg's crack, a film
  strip's bands) join the outline.
- **Arcs end on their circle**: arc endpoints sit on the 0.5 grid, and an endpoint off the circle
  silently moves the centre. Use radii with exact grid points (r 2.5, 5, 6.5, 7.5, 10 have them) or
  build the curve as a cubic through grid anchors.
- **Silhouette from Iconly, detail from Phosphor**: keep the marks that say what the object is
  (the document's fold, the trash's ribs, the calendar's rings and header, the folder's tab), drawn
  soft and floating. At most 2 or 3 inner marks. A mark that clots at 16 px is redrawn bigger or
  further apart before it is dropped (§4).

## 9. Markup

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 12h16" />
  <path d="m13 5 7 7-7 7" />
</svg>
```

Allowed elements: `path`, `line`, `polyline`, `polygon`, `circle`, `ellipse`, `rect` **[lint]**.
No `g`, `transform`, `style`, `class`, `id`, `clipPath`, `mask` or text **[lint]**.
Each icon has an entry in `meta.json` (category, tags) **[lint]**.

## 10. Naming

PascalCase in code, kebab-case on disk: `arrow-right.svg` → `ArrowRight`. Where Phosphor has the
same object we keep its name, so migrating is an import-path change.

## 11. Modifiers

A variant (`folder-plus`, `file-x`, `user-plus`, `calendar-check`) is its base icon plus one glyph
from a closed library, in one of two fixed slots, so a whole family reads as one system.

| Slot | Centre | Use |
| --- | --- | --- |
| corner (default) | 18,18 | objects and containers: folder, file, calendar, bell |
| side | 19,9 | figures the corner would cut through: a person (`user-plus`) |

| Modifier | Elements (centreline), drawn for the corner slot |
| --- | --- |
| plus | `M18 15v6` `M15 18h6` |
| minus | `M15 18h6` |
| x | `m16 16 4 4` `m20 16-4 4` |
| check | `m15.5 18 1.5 1.5 3.5-3.5` |

- The icon carries `"modifier": "<name>"` (and `"slot": "side"` when not the corner) in
  `meta.json` and ends with exactly those elements, moved whole to the slot's centre **[lint]**.
- Every other element keeps **6.5** (centreline) from the slot centre, so the modifier floats in its own
  space with at least about 1.5 units of white around it **[lint]**.
- The base makes room by opening, not by shrinking: a container's outline stops where it meets the
  clearance circle (folder, file, calendar); a figure moves aside whole (`user-plus` shifts the person left and
  uses the side slot). Never bite a closed figure: on the QA sheet it read as a broken glyph.
  Inner marks that crowd the modifier at 16 px go (the text lines of `file-x`).
- New modifiers join the library in `scripts/icons.mjs` (`MODIFIERS`) and this table together.

## 12. Optical sizes

A 24-grid drawing at 1.75 renders about 1 px wide at 14 px and its inner marks clot, so the set
has two optical sizes and picks between them by itself.

| Size | Rendered | Stroke | Drawing |
| --- | --- | --- | --- |
| Large | above 16 px | 1.75 | `svg/<name>.svg` |
| Small | 16 px and below | 2.25 (1.5 px at 16, Phosphor bold's weight) | `svg-sm/<name>.svg` when it exists, else the large drawing |

- `src/optical.css` (import once) makes every icon a CSS size container; at 16 px and below it
  raises the stroke and swaps in the small master. Verified in Chromium, WebKit 17.4 and
  Firefox 119. Without the stylesheet the large drawing shows at every size.
- A small master is the same object on the same grid, every rule applies, at stroke 2.25
  **[lint]**. It removes the marks that clot (one rib in the trash, no door on the house, a plain
  "i"), it never changes the silhouette, so swapping sizes never makes an icon jump.
- Draw a small master when the rasterized audit at 12, 14 and 16 px (1x) shows a mark clotting.
  Simple icons (arrows, carets, X, plus, check) need none.
- Size padding: the live area keeps ink about 1 px from the edge (like Lucide and Untitled UI,
  not Tabler's 2 px). More padding would make the icon smaller exactly where it is weakest.

## 13. Fill weight

The solid version (`weight="fill"`, Phosphor's prop name, for selected and status states) is not a
second drawing: it is derived from the outline master, so it can never drift from it.

`meta.json` gives the icon `fill` roles, each a list of element indexes of the outline master:

| Role | In the solid version | Example |
| --- | --- | --- |
| solid | the shape filled, its outline kept | the disc of `check-circle`, the body of `bell` |
| line | stays a stroke | the shackle of `lock`, the rings of `calendar` |
| cut | its stroke knocked out of the solid | the check, the "i", the document's fold and lines |
| hole | its area knocked out | the door of `house`, the hub of `gear-six` |

- **Only an icon with a body gets fill roles**: a container, a disc, an object's silhouette. A
  pure line glyph (check, X, plus, minus, arrows, carets, the three dots) has none and keeps its
  outline under `weight="fill"`. Phosphor's "fill" for those is really another icon (the glyph
  knocked out of a filled square); that is a separate icon here (`check-square`), never a weight.
- **The solid version keeps the roundness**: it is drawn from the same soft geometry with the
  same round stroke wrapped around it, so corners stay soft and every cut has round ends. Never
  draw a separate, sharper fill shape.
- **An open path given the solid role fills to its closing chord** (a bowl to its rim, a bell half to
  the slash, a bow loop to the lid). Draw a part as its own path when its chord would fill the wrong
  area (the cart's handle).
- **A knockout that crosses a solid's edge splits it**. Allowed only when the split is the meaning
  (an egg's crack, a film strip's frames, a slash); otherwise keep every knockout inside the solid.
- **A dot as a knockout** takes the cut role (cut and hole paint a dot the same way).
- Elements not listed are lines. At least one solid; every index is an element; no element has
  two roles **[lint]**. Only the large master carries roles; small masters do not.
- The runtime draws one `currentColor` rect through a mask (white keeps, black knocks out), with a
  `useId` id per instance, so it renders in Server Components and many copies never collide.
- An icon without roles keeps its outline under `weight="fill"` (arrows, carets, X, plus).
- Every knockout must sit inside a solid shape with at least a stroke of solid around it, or the
  cut reads as a broken edge: check it at 14 px in the lab with the Fill toggle.

## 14. Slash

A crossed-out icon (`bell-slash`, `speaker-slash`, `eye-slash`) is its base icon cut by one slash,
built the way Phosphor builds it: the slash lies **on top of** the object, so the cut is one-sided.
Pieces in front of the slash run into it and merge; pieces behind it stop short with a clear gap. A
symmetric gap on both sides reads as a stencil.

- **The slash** is the last element, a 45° line on the diagonal x = y. Its two ends are placed
  independently, on the 0.5 grid, so the slash overhangs the body by the **same amount at both ends
  and in every icon**: the distance from each end to the nearest body centreline is **2.25 ± 0.4**
  (`bell-slash` `M4 4l16 16`; `wifi-slash` `M4 4l13 13`). Equal overhang beats symmetry about
  12,12: a body that sits off the diagonal (a camera, the wifi fan) gets a slash that is shorter at
  one end, never one that hangs out more below than above.
- **Lower-left side (y > x): no gap.** A body piece there ends with its centreline exactly ON the
  slash centreline (x − y = 0), so its round cap merges into the slash. A piece that never reaches
  the slash (the bell's clapper) stays as drawn.
- **Upper-right side (x > y): a gap.** A body piece there breaks on x − y = +5.5 in the large master
  (clear gap about 2.1 units, 1.2 strokes) and on x − y = +6 in the small master, where the 2.25
  stroke needs the extra room to stay open at 14 and 16 px.
- **Break points are anchors on the 0.5 grid.** A curve with no grid point on the line is re-drawn as
  a cubic ending on one; a straight edge keeps its line and breaks on its grid point nearest the line
  (a 45° edge across the gap line lands 0.5 wide of it, never narrower).
- **Everything else is the base icon**, point for point. Which pieces fall on which side follows from
  the geometry, so every slash icon reads the same. A piece shorter than 2 units after the cut is
  dropped (§4). When that would drop a part that names the object, cut a sibling base instead:
  `speaker-slash` is `speaker-low` cut, because on `speaker-high` the diagonal runs through the cone
  tip and the inner wave and leaves stubs; `speaker-low` keeps box, cone tip and wave.
- **Fill**: lower-left pieces are solid and close along the slash; upper-right pieces are solid and
  close along a chord parallel to it (their break line); the slash stays a line. Each piece is its
  own element, so it closes on its own chord. Other base roles carry over (the eye's pupil stays a
  cut). `bell-slash` is the reference:

```svg
<path d="M8.5 3C9.54 2.39 10.71 2 12 2C15.87 2 19 5.13 19 9C19 11.07 19.14 12.66 19.5 14" />
<path d="M18 18H4.5C3.5 18 3.1 17.3 3.5 16.5C4.2 15.1 5 12.6 5 9C5 7.84 5.5 6.96 6 6" />
<path d="M8.5 18C8.5 19.93 10.07 21.5 12 21.5C13.93 21.5 15.5 19.93 15.5 18" />
<path d="M4 4l16 16" />
```

  The dome breaks on x − y = 5.5 (8.5,3 and 19.5,14), the rest of the body ends on the slash (6,6
  and 18,18), the clapper is untouched; fill roles `solid: [0, 1, 2]`.
- When the slash runs through the feature that names the object (the speaker's box-to-cone corner),
  the cut can still weaken it at 14 and 16 px. Keep the `-slash` icon for completeness, and draw the `-x`
  variant (`speaker-x`: the body untouched, a short X where the waves were) as the one to use small.
