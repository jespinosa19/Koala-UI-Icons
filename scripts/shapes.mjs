#!/usr/bin/env node
// The soft corner (SPEC.md §6), the one curvature every corner in the set shares. Use it to write
// path data for a master in svg/, never hand-tune a corner:
//
//   node scripts/shapes.mjs rect <x> <y> <w> <h> <L>            a closed soft rectangle
//   node scripts/shapes.mjs path "<x,y> <x,y> ..." "<L L ...>" [closed]
//                                                              a run of points, L per vertex (0 = sharp)
//
// Tangent points snap to the 0.5 grid (SPEC §3); control points are free.

import { pathToFileURL } from "node:url"

/** Handle distance from the vertex, as a fraction of L. A circular arc would be 0.4477. */
export const K = 0.36

const f = (v) => +(+v).toFixed(2)
const snap = (v) => Math.round(v * 2) / 2

export function softRect(x, y, w, h, L) {
  const c = L * K
  const X = x + w
  const Y = y + h
  return (
    `M${x + L} ${y}H${X - L}C${f(X - c)} ${y} ${X} ${f(y + c)} ${X} ${y + L}` +
    `V${Y - L}C${X} ${f(Y - c)} ${f(X - c)} ${Y} ${X - L} ${Y}` +
    `H${x + L}C${f(x + c)} ${Y} ${x} ${f(Y - c)} ${x} ${Y - L}` +
    `V${y + L}C${x} ${f(y + c)} ${f(x + c)} ${y} ${x + L} ${y}Z`
  )
}

/**
 * Soft corners on a polyline or polygon. `corners[i]` is L at point i; the ends of an open run stay
 * as they are. Pass `snapTo = false` for radial icons (meta `grid: "radial"`).
 */
export function softPath(pts, corners, closed = false, snapTo = true) {
  const n = pts.length
  const s = snapTo ? snap : (v) => v
  const at = (i) => pts[(i + n) % n]
  const seg = pts.map((p, i) => {
    const L = corners[i] ?? 0
    if (!L || (!closed && (i === 0 || i === n - 1))) return { in: p, out: p, p, L: 0 }
    const toward = (q) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      return [s(p[0] + ((q[0] - p[0]) * L) / d), s(p[1] + ((q[1] - p[1]) * L) / d)]
    }
    return { in: toward(at(i - 1)), out: toward(at(i + 1)), p, L }
  })
  const pull = (a, p) => [f(a[0] + (p[0] - a[0]) * (1 - K)), f(a[1] + (p[1] - a[1]) * (1 - K))]
  let d = `M${f(seg[0].out[0])} ${f(seg[0].out[1])}`
  for (let k = 1; k <= (closed ? n : n - 1); k++) {
    const c = seg[k % n]
    d += `L${f(c.in[0])} ${f(c.in[1])}`
    if (c.L) d += `C${pull(c.in, c.p).join(" ")} ${pull(c.out, c.p).join(" ")} ${f(c.out[0])} ${f(c.out[1])}`
  }
  return closed ? `${d}Z` : d
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...a] = process.argv.slice(2)
  if (cmd === "rect") console.log(softRect(...a.map(Number)))
  else if (cmd === "path") {
    const pts = a[0].trim().split(/\s+/).map((p) => p.split(",").map(Number))
    const corners = a[1].trim().split(/\s+/).map(Number)
    console.log(softPath(pts, corners, a[2] === "closed"))
  } else console.log("usage: shapes.mjs rect x y w h L | path \"x,y ...\" \"L ...\" [closed]")
}
