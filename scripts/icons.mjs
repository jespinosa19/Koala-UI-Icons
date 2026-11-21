#!/usr/bin/env node
// Koala Icons toolchain. One file, four commands:
//
//   lint    check every master in svg/ against SPEC.md (the mechanical half of the spec)
//   build   lint, then generate src/: one component per icon, the barrel and the metadata
//   dist    compile src/ to dist/ (JS + .d.ts) with tsconfig.build.json, ready to pack
//   sheet   rasterize a QA contact sheet (16 / 20 / 24 / 48 px, beside Phosphor bold) to a PNG
//
// Run from anywhere: paths resolve against this package. The lint and codegen functions are
// exported so the test suite can drive them with fixture strings; the CLI only runs when this
// file is the entry point.

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SVG_DIR = path.join(ROOT, "svg")
// SPEC §12 optical sizes: an optional small master per icon, shown at 16 px and below.
const SVG_SM_DIR = path.join(ROOT, "svg-sm")
export const SMALL_STROKE = "2.25"
const SRC_DIR = path.join(ROOT, "src")
const DIST_DIR = path.join(ROOT, "dist")
const META_FILE = path.join(ROOT, "meta.json")

// ---------------------------------------------------------------------------------------------
// Spec constants (SPEC.md is the source of truth; keep these in step with it)

export const ROOT_ATTRS = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.75",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
}
const LIVE_MIN = 2
const LIVE_MAX = 22
const MIN_PARALLEL_GAP = 4 // centreline to centreline
const DOT = { r: 1.25, fill: "currentColor", stroke: "none" } // SPEC §7: the only filled element
const MIN_CIRCLE_R = 2
const RECT_RADII = [1, 1.5, 2, 3]
const GRID_MODES = ["radial"] // meta.json `grid`: SPEC §3 exemption from the 0.5-grid anchor check

// SPEC §11 modifiers: a closed library of small glyphs that sit in a fixed slot. An icon with meta
// `modifier` ends with exactly that glyph's elements, and every other element keeps SLOT_CLEAR
// (centreline) away from the slot centre so the modifier floats in its own space. `corner` (bottom
// right) is the default; `side` (top right) is for figures the corner would cut, like a person.
export const SLOTS = { corner: { x: 18, y: 18 }, side: { x: 19, y: 9 } }
export const SLOT_CLEAR = 6.5
// SPEC §13 fill roles: solid = filled silhouette, line = stays a stroke, cut = stroke knocked out,
// hole = area knocked out. Elements not listed are lines.
export const FILL_ROLES = ["solid", "line", "cut", "hole"]
export const MODIFIERS = {
  plus: [["path", { d: "M18 15v6" }], ["path", { d: "M15 18h6" }]],
  minus: [["path", { d: "M15 18h6" }]],
  x: [["path", { d: "m16 16 4 4" }], ["path", { d: "m20 16-4 4" }]],
  check: [["path", { d: "m15.5 18 1.5 1.5 3.5-3.5" }]],
}
// The library is drawn for the corner; another slot moves each glyph's opening moveto (every
// later command is relative, so the glyph moves whole).
export function modifierAt(name, slot = "corner") {
  const dx = SLOTS[slot].x - SLOTS.corner.x
  const dy = SLOTS[slot].y - SLOTS.corner.y
  return MODIFIERS[name].map(([tag, { d }]) => [
    tag,
    { d: d.replace(/^([Mm])\s*(-?\d*\.?\d+)[\s,]*(-?\d*\.?\d+)/, (_, m, x, y) => `${m}${+x + dx} ${+y + dy}`) },
  ])
}
const sameElement = (el, [tag, attrs]) =>
  el.tag === tag &&
  Object.keys(el.attrs).length === Object.keys(attrs).length &&
  Object.entries(attrs).every(([k, v]) => el.attrs[k] === v)

// Closest approach of one segment to a point: exact for lines, sampled finely for curves and arcs.
function distanceTo(seg, c) {
  if (seg.kind === "line") {
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((c.x - seg.a.x) * dx + (c.y - seg.a.y) * dy) / len2)) : 0
    return Math.hypot(seg.a.x + t * dx - c.x, seg.a.y + t * dy - c.y)
  }
  let min = Infinity
  for (let k = 0; k <= 256; k++) {
    const t = k / 256
    const p = seg.kind === "curve" ? cubicPoint(seg.pts, t) : arcPoint(seg, seg.t1 + seg.dt * t)
    min = Math.min(min, Math.hypot(p.x - c.x, p.y - c.y))
  }
  return min
}
// Allowed attributes per element. `fill` / `stroke` on a circle are only valid as the dot (§7).
const ELEMENTS = {
  path: ["d"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  circle: ["cx", "cy", "r", "fill", "stroke"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
}
const REQUIRED = {
  path: ["d"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height"],
}
const NUMERIC = new Set(["x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height"])
const EPS = 1e-6
const LIVE_EPS = 1e-3
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

// ---------------------------------------------------------------------------------------------
// Tiny SVG reader: masters are flat (no groups, no text), so a tag regex is enough and keeps the
// package dependency-free.

export function parseSvg(source) {
  const open = source.match(/<svg\b([^>]*)>/)
  if (!open) throw new Error("no <svg> root")
  const rootAttrs = parseAttrs(open[1])
  const close = source.lastIndexOf("</svg>")
  if (close < open.index) throw new Error("no closing </svg>")
  // Comments go first: one containing markup must not be read as elements.
  const body = source.slice(open.index + open[0].length, close).replace(/<!--[\s\S]*?-->/g, "")
  const children = []
  const tagRe = /<\s*([a-zA-Z][\w:.-]*)\b([^>]*?)\/?>/g
  let m
  while ((m = tagRe.exec(body))) children.push({ tag: m[1], attrs: parseAttrs(m[2]) })
  const stray = body.replace(/<[^>]*>/g, "").trim()
  return { rootAttrs, children, stray }
}

// Double- or single-quoted values; names may carry digits (x1, y2) and namespaces (xlink:href).
// Anything left over (an unquoted value, a bare attribute) is reported under the key "#junk".
export function parseAttrs(str) {
  const attrs = {}
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(str))) attrs[m[1]] = m[2] ?? m[3]
  const junk = str.replace(re, "").replace(/\/\s*$/, "").trim()
  if (junk) attrs["#junk"] = junk
  return attrs
}

// ---------------------------------------------------------------------------------------------
// Geometry: every element becomes a list of segments in absolute coordinates.
//   { kind: "line", a, b } | { kind: "curve", pts: [a, c1, c2, b] } | { kind: "arc", ...centre form }
// plus the "anchor" points that must sit on the 0.5 grid.

const num = (s) => Number.parseFloat(s)
const isCmd = (t) => typeof t === "string"

const NUM_SRC = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`

export function tokenizePath(d) {
  const tokens = []
  const re = new RegExp(String.raw`([MmLlHhVvCcSsQqTtAaZz])|(${NUM_SRC})|([\s,]+)|(.)`, "g")
  let m
  while ((m = re.exec(d))) {
    if (m[4] != null) throw new Error(`unexpected character ${JSON.stringify(m[4])} in path data`)
    if (m[1] != null) tokens.push(m[1])
    else if (m[2] != null) tokens.push(Number.parseFloat(m[2]))
  }
  return tokens
}

// Arc flags may be written without separators ("a3 3 0 013 3"); split them before tokenizing.
export function normalizeArcFlags(d) {
  return d.replace(/([Aa])([^MmLlHhVvCcSsQqTtAaZz]*)/g, (_, cmd, args) => {
    const out = []
    let rest = args
    for (let i = 0; ; i++) {
      rest = rest.replace(/^[\s,]+/, "")
      if (!rest) break
      // Positions 3 and 4 of each 7-number group are the one-character flags.
      const flag = i % 7 === 3 || i % 7 === 4
      const tok = flag ? rest[0] : rest.match(new RegExp(`^${NUM_SRC}`))?.[0]
      if (!tok || (flag && tok !== "0" && tok !== "1")) throw new Error(`malformed arc arguments ${JSON.stringify(args.trim())}`)
      out.push(tok)
      rest = rest.slice(tok.length)
    }
    return `${cmd} ${out.join(" ")} `
  })
}

export function pathSegments(d) {
  const tokens = tokenizePath(normalizeArcFlags(d))
  const segs = []
  const anchors = []
  let i = 0
  let cmd = null
  let cur = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  // The previous command's control point, tagged with its family: S reflects only a cubic
  // control (after C/S), T only a quadratic one (after Q/T). Anything else: no reflection.
  let lastCtrl = null
  let lastKind = null
  const next = () => {
    const t = tokens[i++]
    if (typeof t !== "number") throw new Error(`path command ${cmd} is missing arguments`)
    return t
  }
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]
    else if (cmd === null) throw new Error("path data must start with a command (or a number follows Z)")
    if (segs.length === 0 && anchors.length === 0 && cmd.toUpperCase() !== "M") throw new Error("path data must start with M")
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const pt = (x, y) => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y })
    let ctrl = null
    let kind = null
    switch (C) {
      case "M": {
        cur = pt(next(), next())
        start = cur
        anchors.push(cur)
        cmd = rel ? "l" : "L" // extra pairs after M are implicit L
        break
      }
      case "L": {
        const p = pt(next(), next())
        segs.push({ kind: "line", a: cur, b: p })
        anchors.push(p)
        cur = p
        break
      }
      case "H": {
        const x = next()
        const p = { x: rel ? cur.x + x : x, y: cur.y }
        segs.push({ kind: "line", a: cur, b: p })
        anchors.push(p)
        cur = p
        break
      }
      case "V": {
        const y = next()
        const p = { x: cur.x, y: rel ? cur.y + y : y }
        segs.push({ kind: "line", a: cur, b: p })
        anchors.push(p)
        cur = p
        break
      }
      case "C":
      case "S": {
        const c1 = C === "C" ? pt(next(), next()) : lastKind === "cubic" ? reflect(lastCtrl, cur) : cur
        const c2 = pt(next(), next())
        const p = pt(next(), next())
        segs.push({ kind: "curve", pts: [cur, c1, c2, p] })
        anchors.push(p)
        ctrl = c2
        kind = "cubic"
        cur = p
        break
      }
      case "Q":
      case "T": {
        const q = C === "Q" ? pt(next(), next()) : lastKind === "quad" ? reflect(lastCtrl, cur) : cur
        const p = pt(next(), next())
        segs.push({ kind: "curve", pts: [cur, lerp(cur, q, 2 / 3), lerp(p, q, 2 / 3), p] })
        anchors.push(p)
        ctrl = q
        kind = "quad"
        cur = p
        break
      }
      case "A": {
        const rx = next()
        const ry = next()
        const rot = next()
        const large = next()
        const sweep = next()
        const p = pt(next(), next())
        // SVG F.6.2: coincident endpoints draw nothing; a zero radius draws a straight line.
        if (p.x !== cur.x || p.y !== cur.y)
          segs.push(rx === 0 || ry === 0 ? { kind: "line", a: cur, b: p } : arcToCenter(cur, p, rx, ry, rot, large, sweep))
        anchors.push(p)
        cur = p
        break
      }
      case "Z": {
        if (Math.hypot(cur.x - start.x, cur.y - start.y) > EPS) segs.push({ kind: "line", a: cur, b: start })
        cur = start
        // Z takes no arguments; a number after it is an implicit L in some writers. Not ours.
        cmd = null
        break
      }
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
    lastCtrl = ctrl
    lastKind = kind
  }
  return { segs, anchors }
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const reflect = (p, about) => ({ x: 2 * about.x - p.x, y: 2 * about.y - p.y })

// SVG arc endpoint form -> centre form (SVG 1.1 implementation notes F.6.5).
export function arcToCenter(p1, p2, rx, ry, rotDeg, large, sweep) {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (rotDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (p1.x - p2.x) / 2
  const dy = (p1.y - p2.y) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const sign = large === sweep ? -1 : 1
  const numr = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = sign * Math.sqrt(Math.max(0, numr / den))
  const cxp = (coef * (rx * y1p)) / ry
  const cyp = (coef * -(ry * x1p)) / rx
  const cx = cos * cxp - sin * cyp + (p1.x + p2.x) / 2
  const cy = sin * cxp + cos * cyp + (p1.y + p2.y) / 2
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  return { kind: "arc", cx, cy, rx, ry, phi, t1, dt, a: p1, b: p2 }
}

const arcPoint = (seg, th) => {
  const x = seg.rx * Math.cos(th)
  const y = seg.ry * Math.sin(th)
  return {
    x: Math.cos(seg.phi) * x - Math.sin(seg.phi) * y + seg.cx,
    y: Math.sin(seg.phi) * x + Math.cos(seg.phi) * y + seg.cy,
  }
}

const cubicPoint = ([p0, p1, p2, p3], t) => {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

// Roots in (0, 1) of the derivative of one cubic Bézier coordinate.
function cubicExtremaT(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const ts = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const s = Math.sqrt(disc)
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a))
    }
  }
  return ts.filter((t) => t > 0 && t < 1)
}

// The points where a segment reaches its bounding box: endpoints plus the analytic extrema
// (cubic derivative roots, arc axis tangents). Exact, so a bulge between samples can't hide.
export function segmentExtremes(seg) {
  if (seg.kind === "line") return [seg.a, seg.b]
  if (seg.kind === "curve") {
    const [p0, p1, p2, p3] = seg.pts
    const ts = [...cubicExtremaT(p0.x, p1.x, p2.x, p3.x), ...cubicExtremaT(p0.y, p1.y, p2.y, p3.y)]
    return [p0, p3, ...ts.map((t) => cubicPoint(seg.pts, t))]
  }
  const lo = Math.min(seg.t1, seg.t1 + seg.dt)
  const hi = Math.max(seg.t1, seg.t1 + seg.dt)
  const cos = Math.cos(seg.phi)
  const sin = Math.sin(seg.phi)
  const bases = [Math.atan2(-seg.ry * sin, seg.rx * cos), Math.atan2(seg.ry * cos, seg.rx * sin)]
  const out = [arcPoint(seg, lo), arcPoint(seg, hi)]
  for (const base of bases)
    for (let k = Math.floor((lo - base) / Math.PI) - 1; base + k * Math.PI <= hi + EPS; k++) {
      const th = base + k * Math.PI
      if (th >= lo - EPS) out.push(arcPoint(seg, th))
    }
  return out
}

export function pointsAttr(s) {
  const raw = s.trim().split(/[\s,]+/).filter(Boolean)
  if (raw.some((t) => !NUMBER.test(t))) throw new Error(`points has a non-number`)
  if (raw.length % 2) throw new Error(`points has an odd number of coordinates`)
  const n = raw.map(num)
  const pts = []
  for (let k = 0; k + 1 < n.length; k += 2) pts.push({ x: n[k], y: n[k + 1] })
  return pts
}

const isDotAttrs = (tag, a) => tag === "circle" && (a.fill != null || a.stroke != null)

export function elementGeometry(tag, a) {
  switch (tag) {
    case "path":
      return pathSegments(a.d)
    case "line": {
      const p = { x: num(a.x1), y: num(a.y1) }
      const q = { x: num(a.x2), y: num(a.y2) }
      return { segs: [{ kind: "line", a: p, b: q }], anchors: [p, q] }
    }
    case "polyline":
    case "polygon": {
      const pts = pointsAttr(a.points)
      if (pts.length < 2) throw new Error("needs at least two points")
      const segs = []
      for (let k = 1; k < pts.length; k++) segs.push({ kind: "line", a: pts[k - 1], b: pts[k] })
      if (tag === "polygon" && pts.length > 2) segs.push({ kind: "line", a: pts.at(-1), b: pts[0] })
      return { segs, anchors: pts }
    }
    case "circle":
    case "ellipse": {
      const cx = num(a.cx)
      const cy = num(a.cy)
      const centre = { x: cx, y: cy }
      // The dot is filled, not stroked: its centre is what the live area checks (SPEC §7).
      if (isDotAttrs(tag, a)) return { segs: [], anchors: [centre], dot: centre }
      const rx = num(tag === "circle" ? a.r : a.rx)
      const ry = num(tag === "circle" ? a.r : a.ry)
      return { segs: [{ kind: "arc", cx, cy, rx, ry, phi: 0, t1: 0, dt: 2 * Math.PI }], anchors: [centre] }
    }
    case "rect": {
      const x = num(a.x)
      const y = num(a.y)
      const w = num(a.width)
      const h = num(a.height)
      const r = Math.min(num(a.rx ?? a.ry ?? "0") || 0, w / 2, h / 2)
      const segs = [
        { kind: "line", a: { x: x + r, y }, b: { x: x + w - r, y } },
        { kind: "line", a: { x: x + w, y: y + r }, b: { x: x + w, y: y + h - r } },
        { kind: "line", a: { x: x + w - r, y: y + h }, b: { x: x + r, y: y + h } },
        { kind: "line", a: { x, y: y + h - r }, b: { x, y: y + r } },
      ].filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > EPS)
      if (r > 0) {
        for (const [cx, cy, t1] of [
          [x + w - r, y + r, -Math.PI / 2],
          [x + w - r, y + h - r, 0],
          [x + r, y + h - r, Math.PI / 2],
          [x + r, y + r, Math.PI],
        ])
          segs.push({ kind: "arc", cx, cy, rx: r, ry: r, phi: 0, t1, dt: Math.PI / 2 })
      }
      return { segs, anchors: [{ x, y }, { x: x + w, y: y + h }] }
    }
  }
  return { segs: [], anchors: [] }
}

// ---------------------------------------------------------------------------------------------
// Lint

const onGrid = (v, step) => Math.abs(v / step - Math.round(v / step)) < EPS
const fmt = (p) => `${+p.x.toFixed(3)},${+p.y.toFixed(3)}`
const outside = (p) =>
  !(p.x >= LIVE_MIN - LIVE_EPS && p.x <= LIVE_MAX + LIVE_EPS && p.y >= LIVE_MIN - LIVE_EPS && p.y <= LIVE_MAX + LIVE_EPS)

/**
 * Lint one master. `meta` is the whole meta.json object. Returns a list of messages, empty when
 * the icon passes.
 */
export function lintIcon(name, source, meta, { small = false } = {}) {
  const errors = []
  // The small master is the same drawing system at a heavier stroke (SPEC §12).
  const rootAttrs = small ? { ...ROOT_ATTRS, "stroke-width": SMALL_STROKE } : ROOT_ATTRS
  let svg
  try {
    svg = parseSvg(source)
  } catch (e) {
    return [e.message]
  }
  for (const [k, v] of Object.entries(rootAttrs))
    if (svg.rootAttrs[k] !== v) errors.push(`root ${k} must be "${v}" (got ${JSON.stringify(svg.rootAttrs[k])})`)
  for (const k of Object.keys(svg.rootAttrs))
    if (!(k in ROOT_ATTRS)) errors.push(k === "#junk" ? `root has malformed attributes: ${svg.rootAttrs[k]}` : `root attribute ${k} is not allowed`)
  if (svg.stray) errors.push(`stray text in body: ${JSON.stringify(svg.stray.slice(0, 40))}`)

  const entry = meta != null && Object.hasOwn(meta, name) ? meta[name] : null
  if (!entry || typeof entry !== "object") errors.push(`missing meta.json entry`)
  else {
    if (typeof entry.category !== "string" || !entry.category) errors.push(`meta.json: no category`)
    if (!Array.isArray(entry.tags) || entry.tags.length === 0) errors.push(`meta.json: no tags`)
    if (entry.grid != null && !GRID_MODES.includes(entry.grid))
      errors.push(`meta.json: grid must be ${GRID_MODES.map((g) => `"${g}"`).join(" or ")} (got ${JSON.stringify(entry.grid)})`)
    if (entry.modifier != null && !Object.hasOwn(MODIFIERS, entry.modifier))
      errors.push(`meta.json: modifier must be one of ${Object.keys(MODIFIERS).join(", ")} (got ${JSON.stringify(entry.modifier)})`)
    if (entry.fill != null && !small) {
      // SPEC §13: the fill weight is derived from the outline master; each role lists element indexes.
      const roles = entry.fill
      const seen = new Set()
      if (typeof roles !== "object" || Array.isArray(roles)) errors.push("meta.json: fill must be an object of roles")
      else
        for (const [role, list] of Object.entries(roles)) {
          if (!FILL_ROLES.includes(role)) errors.push(`meta.json: fill role must be one of ${FILL_ROLES.join(", ")} (got "${role}")`)
          if (!Array.isArray(list)) continue
          for (const i of list) {
            if (!Number.isInteger(i) || i < 0 || i >= svg.children.length)
              errors.push(`meta.json: fill.${role} index ${i} is not an element of the master`)
            else if (seen.has(i)) errors.push(`meta.json: element ${i} has two fill roles`)
            seen.add(i)
          }
        }
      if (!roles?.solid?.length) errors.push("meta.json: fill needs at least one solid element")
    }
    if (entry.slot != null && (entry.modifier == null || !Object.hasOwn(SLOTS, entry.slot)))
      errors.push(`meta.json: slot must be one of ${Object.keys(SLOTS).join(", ")}, beside a modifier (got ${JSON.stringify(entry.slot)})`)
  }
  // The modifier's elements close the icon, exactly as the library draws them (SPEC §11).
  const slotName = entry && Object.hasOwn(SLOTS, entry.slot ?? "corner") ? (entry.slot ?? "corner") : "corner"
  const SLOT = SLOTS[slotName]
  const modifier = entry && Object.hasOwn(MODIFIERS, entry.modifier ?? "") ? modifierAt(entry.modifier, slotName) : null
  const baseCount = modifier ? svg.children.length - modifier.length : svg.children.length
  if (modifier && !(baseCount > 0 && modifier.every((m, i) => sameElement(svg.children[baseCount + i], m))))
    errors.push(`the ${entry.modifier} modifier must close the icon, exactly as in MODIFIERS (SPEC §11)`)
  // Radial icons (60 / 72 degree symmetry: gear, star, sun) cannot put their points on the 0.5
  // grid; they skip that one check and nothing else (SPEC §3).
  const radial = entry?.grid === "radial"
  if (svg.children.length === 0) errors.push("empty icon")

  const axis = [] // axis-aligned line segments for the clearance check
  for (const [index, { tag, attrs }] of svg.children.entries()) {
    const allowed = ELEMENTS[tag]
    if (!allowed) {
      errors.push(`<${tag}> is not allowed`)
      continue
    }
    let malformed = false
    for (const k of Object.keys(attrs)) {
      if (k === "#junk") {
        errors.push(`<${tag}> has malformed attributes: ${attrs[k]}`)
        malformed = true
      } else if (!allowed.includes(k)) errors.push(`<${tag}> attribute ${k} is not allowed`)
      else if (NUMERIC.has(k) && !NUMBER.test(attrs[k].trim())) {
        errors.push(`<${tag}> ${k}="${attrs[k]}" is not a plain number`)
        malformed = true
      }
    }
    for (const k of REQUIRED[tag])
      if (attrs[k] == null) {
        errors.push(`<${tag}> needs ${k}`)
        malformed = true
      }
    if (malformed) continue

    if (tag === "circle") {
      const r = num(attrs.r)
      if (isDotAttrs(tag, attrs)) {
        if (r !== DOT.r || attrs.fill !== DOT.fill || attrs.stroke !== DOT.stroke)
          errors.push(`circle with fill/stroke must be the dot: r="${DOT.r}" fill="${DOT.fill}" stroke="${DOT.stroke}"`)
      } else if (r < MIN_CIRCLE_R) {
        errors.push(
          `circle r=${r}: a shape is r>=${MIN_CIRCLE_R}; a dot is <circle r="${DOT.r}" fill="${DOT.fill}" stroke="${DOT.stroke}" />`,
        )
      }
    }
    if (tag === "ellipse" && (num(attrs.rx) < MIN_CIRCLE_R || num(attrs.ry) < MIN_CIRCLE_R))
      errors.push(`ellipse radii must be >= ${MIN_CIRCLE_R}`)
    if (tag === "rect") {
      const w = num(attrs.width)
      const h = num(attrs.height)
      if (!(w > 0) || !(h > 0)) errors.push(`rect width and height must be positive`)
      // ry alone means rx = ry (SVG); both given must agree.
      const rx = num(attrs.rx ?? attrs.ry ?? "0")
      if (attrs.rx != null && attrs.ry != null && num(attrs.ry) !== rx) errors.push("rect ry must equal rx")
      const full = Math.abs(rx - Math.min(w, h) / 2) < EPS
      if (rx !== 0 && !full && !RECT_RADII.includes(rx))
        errors.push(`rect rx=${rx}: use ${RECT_RADII.join(", ")} or a full pill`)
    }

    let geo
    try {
      geo = elementGeometry(tag, attrs)
    } catch (e) {
      errors.push(`<${tag}>: ${e.message}`)
      continue
    }
    if (!radial)
      for (const p of geo.anchors)
        if (!onGrid(p.x, 0.5) || !onGrid(p.y, 0.5)) errors.push(`<${tag}> point ${fmt(p)} is off the 0.5 grid`)
    if (geo.dot && outside(geo.dot)) errors.push(`<${tag}> dot centre ${fmt(geo.dot)} leaves the live area (2 to 22)`)
    if (modifier && index < baseCount) {
      const near = geo.dot
        ? Math.hypot(geo.dot.x - SLOT.x, geo.dot.y - SLOT.y) - DOT.r
        : Math.min(...geo.segs.map((seg) => distanceTo(seg, SLOT)))
      if (near < SLOT_CLEAR - LIVE_EPS)
        errors.push(`<${tag}> comes ${+near.toFixed(2)} from the modifier slot (min ${SLOT_CLEAR}, SPEC §11)`)
    }
    for (const seg of geo.segs) {
      if (seg.kind === "line") {
        const horiz = Math.abs(seg.a.y - seg.b.y) < EPS
        const vert = Math.abs(seg.a.x - seg.b.x) < EPS
        const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y)
        if (horiz && len > 0.05 && !onGrid(seg.a.y, 1))
          errors.push(`horizontal segment at y=${+seg.a.y.toFixed(3)} is not on a whole pixel`)
        if (vert && len > 0.05 && !onGrid(seg.a.x, 1))
          errors.push(`vertical segment at x=${+seg.a.x.toFixed(3)} is not on a whole pixel`)
        if ((horiz || vert) && len > 0.05) axis.push({ horiz, ...seg })
      }
      const pts = segmentExtremes(seg)
      if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) errors.push(`<${tag}> has degenerate geometry`)
      else {
        const p = pts.find(outside)
        if (p) errors.push(`<${tag}> leaves the live area (2 to 22) near ${fmt(p)}`)
      }
    }
  }

  // Parallel clearance: two axis-aligned segments that overlap along their length and do not
  // touch must keep MIN_PARALLEL_GAP between centrelines.
  const along = (seg) => (seg.horiz ? [seg.a.x, seg.b.x] : [seg.a.y, seg.b.y]).sort((p, q) => p - q)
  const across = (seg) => (seg.horiz ? seg.a.y : seg.a.x)
  for (let i = 0; i < axis.length; i++) {
    for (let j = i + 1; j < axis.length; j++) {
      const s = axis[i]
      const t = axis[j]
      if (s.horiz !== t.horiz) continue
      const [s0, s1] = along(s)
      const [t0, t1] = along(t)
      const overlap = Math.min(s1, t1) - Math.max(s0, t0)
      if (overlap <= EPS) continue
      const gap = Math.abs(across(s) - across(t))
      if (gap > EPS && gap < MIN_PARALLEL_GAP - EPS)
        errors.push(
          `parallel ${s.horiz ? "horizontal" : "vertical"} strokes ${+gap.toFixed(3)} apart (min ${MIN_PARALLEL_GAP}) at ${s.horiz ? "y" : "x"}=${across(s)} / ${across(t)}`,
        )
      if (gap <= EPS) errors.push(`overlapping strokes at ${s.horiz ? "y" : "x"}=${across(s)}`)
    }
  }
  return [...new Set(errors)]
}

export const isKebab = (name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)

/**
 * Lint a whole set: `icons` is [{ name, source }], `meta` the meta.json object. Returns
 * { failures: [{ name, errors }], orphans: [meta names without an svg] }.
 */
export function lintSet(icons, meta) {
  const failures = []
  for (const icon of icons) {
    const errors = isKebab(icon.name) ? [...lintIcon(icon.name, icon.source, meta)] : ["file name must be kebab-case"]
    if (icon.small != null)
      for (const e of lintIcon(icon.name, icon.small, meta, { small: true })) errors.push(`small: ${e}`)
    if (errors.length) failures.push({ name: icon.name, errors })
  }
  const names = new Set(icons.map((i) => i.name))
  const orphans = Object.keys(meta).filter((name) => !names.has(name))
  return { failures, orphans }
}

function readAll() {
  const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"))
  // One file per category in meta/ (so parallel drawing never edits the same file), merged into
  // meta.json's entries. A name defined twice is a hard error, never a silent override.
  const META_DIR = path.join(ROOT, "meta")
  if (fs.existsSync(META_DIR))
    for (const f of fs.readdirSync(META_DIR).filter((f) => f.endsWith(".json")).sort()) {
      const part = JSON.parse(fs.readFileSync(path.join(META_DIR, f), "utf8"))
      for (const [name, entry] of Object.entries(part)) {
        if (Object.hasOwn(meta, name)) throw new Error(`meta/${f}: "${name}" is already defined`)
        meta[name] = entry
      }
    }
  const files = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg")).sort()
  const icons = files.map((f) => {
    const name = f.replace(/\.svg$/, "")
    const smallFile = path.join(SVG_SM_DIR, f)
    return {
      name,
      file: path.join(SVG_DIR, f),
      source: fs.readFileSync(path.join(SVG_DIR, f), "utf8"),
      small: fs.existsSync(smallFile) ? fs.readFileSync(smallFile, "utf8") : undefined,
    }
  })
  // A small master without its large master is an orphan.
  if (fs.existsSync(SVG_SM_DIR))
    for (const f of fs.readdirSync(SVG_SM_DIR).filter((f) => f.endsWith(".svg")))
      if (!files.includes(f)) throw new Error(`svg-sm/${f} has no svg/${f}`)
  return { meta, icons }
}

function lint({ quiet = false } = {}) {
  const { meta, icons } = readAll()
  const { failures, orphans } = lintSet(icons, meta)
  const failed = new Map(failures.map((f) => [f.name, f.errors]))
  for (const icon of icons) {
    const errors = failed.get(icon.name)
    if (errors) {
      console.log(`✗ ${icon.name}`)
      for (const e of errors) console.log(`    ${e}`)
    } else if (!quiet) console.log(`✓ ${icon.name}`)
  }
  for (const name of orphans) console.log(`✗ meta.json lists "${name}" but svg/${name}.svg does not exist`)
  console.log(`\n${icons.length - failures.length} / ${icons.length} icons pass the spec`)
  return failures.length === 0 && orphans.length === 0
}

// ---------------------------------------------------------------------------------------------
// Build

export const pascal = (kebab) => kebab.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase())

const HEADER = "// Generated by scripts/icons.mjs from svg/. Do not edit.\n"
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * Pure codegen: [{ name, source }] + meta -> { "relative/path.ts": contents }. Output depends only
 * on the inputs' content, never on their order (icons sorted by name, meta keys in a fixed order),
 * so a rebuild of the same masters is byte-identical.
 */
export function generate(icons, meta) {
  const sorted = [...icons].sort(byName)
  const files = {}
  const exports = []
  for (const icon of sorted) {
    const toNode = (source) =>
      parseSvg(source).children.map(({ tag, attrs }) => {
        const pairs = Object.entries(attrs).map(([k, v]) => {
          const n = Number(v)
          return `${k}: ${NUMERIC.has(k) && NUMBER.test(v) && Number.isFinite(n) ? String(n) : JSON.stringify(v)}`
        })
        return `["${tag}", { ${pairs.join(", ")} }]`
      })
    const list = (node) => `[\n  ${node.join(",\n  ")},\n]`
    const node = toNode(icon.source)
    // SPEC §12: the small master rides along; without one the large drawing serves both sizes.
    // SPEC §13: the fill roles ride along as the fourth argument.
    const roles = meta[icon.name]?.fill
    const small = icon.small != null ? `, ${list(toNode(icon.small))}` : roles ? ", undefined" : ""
    const fill = roles ? `, ${JSON.stringify(roles)}` : ""
    const Name = pascal(icon.name)
    files[`icons/${icon.name}.ts`] =
      `${HEADER}import { createIcon } from "../create-icon"\n\nexport const ${Name} = /* @__PURE__ */ createIcon("${icon.name}", ${list(node)}${small}${fill})\n`
    exports.push(`export { ${Name} } from "./icons/${icon.name}"`)
  }
  files["index.ts"] =
    `${HEADER}export { createIcon } from "./create-icon"\nexport type { IconProps, IconNode, IconComponent } from "./create-icon"\n\n${exports.join("\n")}\n`
  const metaOut = sorted.map((i) => {
    const m = meta[i.name] ?? {}
    const out = { name: i.name, component: pascal(i.name), category: m.category, tags: m.tags }
    if (m.phosphor != null) out.phosphor = m.phosphor
    if (m.grid != null) out.grid = m.grid
    if (m.modifier != null) out.modifier = m.modifier
    if (m.slot != null) out.slot = m.slot
    if (m.fill != null) out.fill = true
    return out
  })
  files["meta.ts"] =
    `${HEADER}export interface IconMeta {\n  name: string\n  component: string\n  category: string\n  tags: string[]\n  phosphor?: string\n  grid?: "radial"\n  modifier?: ${Object.keys(MODIFIERS).map((k) => `"${k}"`).join(" | ")}\n  slot?: ${Object.keys(SLOTS).map((k) => `"${k}"`).join(" | ")}\n  fill?: boolean\n}\n\nexport const ICONS: IconMeta[] = ${JSON.stringify(metaOut, null, 2)}\n`
  return files
}

function build() {
  if (!lint({ quiet: true })) {
    console.error("\nbuild stopped: fix the icons above first")
    process.exit(1)
  }
  const { meta, icons } = readAll()
  fs.rmSync(path.join(SRC_DIR, "icons"), { recursive: true, force: true })
  for (const [rel, contents] of Object.entries(generate(icons, meta))) {
    const file = path.join(SRC_DIR, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  console.log(`\nbuilt ${icons.length} icons into src/`)
}

// ---------------------------------------------------------------------------------------------
// Dist: tsc emits extensionless relative imports (the source is written for bundlers), but Node's
// ESM loader needs a file extension. Add ".js" to every relative specifier after compiling.

export function addJsExtensions(code) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+?)\2/g, (m, pre, q, spec) =>
    /\.(?:m?js|json)$/.test(spec) ? m : `${pre}${q}${spec}.js${q}`,
  )
}

function dist() {
  const require = createRequire(import.meta.url)
  const tsc = require.resolve("typescript/bin/tsc")
  fs.rmSync(DIST_DIR, { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json")], { stdio: "inherit" })
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  const files = walk(DIST_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
  for (const f of files) fs.writeFileSync(f, addJsExtensions(fs.readFileSync(f, "utf8")))
  // tsc only emits code; the optical-size stylesheet (SPEC §12) ships beside it.
  fs.copyFileSync(path.join(SRC_DIR, "optical.css"), path.join(DIST_DIR, "optical.css"))
  console.log(`dist: ${files.length} files in ${path.relative(process.cwd(), DIST_DIR) || "."}`)
}

// ---------------------------------------------------------------------------------------------
// QA sheet: rasterized with sharp (librsvg) so the small sizes show real antialiasing, not a
// browser's zoomed vector. Each row: keyline overlay at 8x, then 16/20/24/48 px for Koala, then
// the same sizes for Phosphor bold when meta.json names a counterpart.

function phosphorBold(name) {
  const file = path.resolve(ROOT, "../../node_modules/@phosphor-icons/react/dist/defs", `${name}.es.js`)
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, "utf8")
  const start = src.indexOf('"bold"')
  const end = src.indexOf("]", start)
  const chunk = src.slice(start, end)
  const els = []
  const re = /createElement\("(\w+)", (\{[^}]*\})\)/g
  let m
  while ((m = re.exec(chunk))) {
    const attrs = Function(`return (${m[2]})`)()
    els.push(`<${m[1]} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
  }
  return els.join("")
}

// ---------------------------------------------------------------------------------------------
// Alignment audit (SPEC §5): rasterize each master at 10x and report how far its ink box and its
// ink centroid sit from the canvas centre. A box more than 0.5 off is flagged; the centroid is
// context (an arrow leans to its head, a lock to its body) for the reviewer to judge.

async function audit(args) {
  const sharp = (await import("sharp")).default
  const { icons } = readAll()
  const only = args.filter((a) => !a.startsWith("--"))
  const list = only.length ? icons.filter((i) => only.includes(i.name)) : icons
  const S = 240
  const K = S / 24
  const rows = []
  for (const icon of list) {
    const src = icon.source.replace("<svg ", `<svg width="${S}" height="${S}" color="#000" `)
    const { data, info } = await sharp(Buffer.from(src)).flatten({ background: "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true })
    let x0 = S, y0 = S, x1 = 0, y1 = 0, sx = 0, sy = 0, sw = 0
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const ink = (255 - data[y * info.width + x]) / 255
        if (ink < 0.5) continue
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        sx += x * ink; sy += y * ink; sw += ink
      }
    const bdx = (x0 + x1 + 1) / 2 / K - 12
    const bdy = (y0 + y1 + 1) / 2 / K - 12
    rows.push({ name: icon.name, bdx, bdy, mdx: sx / sw / K - 12, mdy: sy / sw / K - 12 })
  }
  const f2 = (v) => (v >= 0 ? "+" : "") + v.toFixed(2)
  rows.sort((a, b) => Math.max(Math.abs(b.bdx), Math.abs(b.bdy)) - Math.max(Math.abs(a.bdx), Math.abs(a.bdy)))
  let flagged = 0
  for (const r of rows) {
    const off = Math.max(Math.abs(r.bdx), Math.abs(r.bdy)) > 0.5 + 1e-6
    if (off) flagged++
    if (off || only.length || args.includes("--all"))
      console.log(`${off ? "!" : " "} ${r.name.padEnd(22)} box ${f2(r.bdx)} ${f2(r.bdy)}   mass ${f2(r.mdx)} ${f2(r.mdy)}`)
  }
  console.log(`\n${flagged} of ${rows.length} icons have their ink box more than 0.5 off centre`)
}

async function sheet(args) {
  const sharp = (await import("sharp")).default
  const { meta, icons } = readAll()
  const only = args.filter((a) => !a.startsWith("--"))
  const list = only.length ? icons.filter((i) => only.includes(i.name)) : icons
  const outArg = args.find((a) => a.startsWith("--out="))
  const out = outArg ? outArg.slice(6) : path.join(ROOT, ".qa", "sheet.png")
  const dark = args.includes("--dark")
  const ink = dark ? "#f4f4f5" : "#18181b"
  const paper = dark ? "#18181b" : "#ffffff"
  // 14 and 16 render as the browser will: the small master if any, at the small stroke (SPEC §12).
  const SIZES = [14, 16, 20, 24, 48]
  const KEY = 8 // keyline magnification
  const rowH = 24 * KEY + 24
  const colKoala = 24 * KEY + 40
  const width = colKoala + 2 * (SIZES.reduce((s, x) => s + x + 24, 0) + 40) + 40
  const height = list.length * rowH + 40

  const keylines = `
    <rect x="0" y="0" width="24" height="24" fill="${dark ? "#27272a" : "#f4f4f5"}"/>
    <rect x="1" y="1" width="22" height="22" fill="${paper}"/>
    ${Array.from({ length: 25 }, (_, k) => `<path d="M${k} 0V24M0 ${k}H24" stroke="${dark ? "#3f3f46" : "#e4e4e7"}" stroke-width="0.05"/>`).join("")}
    <g fill="none" stroke="#38bdf8" stroke-width="0.08">
      <circle cx="12" cy="12" r="9.5"/><path d="M7 3H17C19.56 3 21 4.44 21 7V17C21 19.56 19.56 21 17 21H7C4.44 21 3 19.56 3 17V7C3 4.44 4.44 3 7 3Z"/>
      <path d="M8 2H16C18.56 2 20 3.44 20 6V18C20 20.56 18.56 22 16 22H8C5.44 22 4 20.56 4 18V6C4 3.44 5.44 2 8 2Z"/><path d="M6 4H18C20.56 4 22 5.44 22 8V16C22 18.56 20.56 20 18 20H6C3.44 20 2 18.56 2 16V8C2 5.44 3.44 4 6 4Z"/>
      <path d="M2 2H22V22H2Z" stroke="#f472b6"/>
    </g>`

  let body = ""
  list.forEach((icon, row) => {
    const y = 20 + row * rowH
    // The body after the <svg> open tag (not after the first ">", which may close an XML prolog).
    const open = icon.source.match(/<svg\b[^>]*>/)
    const innerXml = icon.source.slice(open.index + open[0].length, icon.source.lastIndexOf("</svg>"))
    // `color` too: the dot (SPEC §7) fills with currentColor, so it must resolve to the ink.
    const stroke = `fill="none" stroke="${ink}" color="${ink}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`
    // The centreline overlay hides the dot (transparent currentColor): it has no centreline.
    body += `<svg x="20" y="${y}" width="${24 * KEY}" height="${24 * KEY}" viewBox="0 0 24 24">${keylines}<g ${stroke} stroke-opacity="0.85">${innerXml}</g><g fill="none" stroke="#ef4444" color="transparent" stroke-width="0.06">${innerXml}</g></svg>`
    const smallXml = icon.small ? icon.small.slice(icon.small.match(/<svg\b[^>]*>/).index + icon.small.match(/<svg\b[^>]*>/)[0].length, icon.small.lastIndexOf("</svg>")) : innerXml
    let x = colKoala
    for (const s of SIZES) {
      const art = s <= 16 ? `${stroke.replace('stroke-width="1.75"', `stroke-width="${SMALL_STROKE}"`)}>${smallXml}` : `${stroke}>${innerXml}`
      body += `<svg x="${x}" y="${y + 24 * KEY - s}" width="${s}" height="${s}" viewBox="0 0 24 24" ${art}</svg>`
      x += s + 24
    }
    const ph = meta[icon.name]?.phosphor ? phosphorBold(meta[icon.name].phosphor) : null
    x += 40
    if (ph)
      for (const s of SIZES) {
        body += `<svg x="${x}" y="${y + 24 * KEY - s}" width="${s}" height="${s}" viewBox="0 0 256 256" fill="${ink}">${ph}</svg>`
        x += s + 24
      }
    body += `<text x="${colKoala}" y="${y + 24}" font-family="Segoe UI, sans-serif" font-size="16" fill="${ink}">${icon.name}${ph ? `   ·   Phosphor ${meta[icon.name].phosphor} bold →` : ""}</text>`
  })
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${paper}"/>${body}</svg>`
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await sharp(Buffer.from(doc), { density: 72 }).png().toFile(out)
  console.log(`sheet: ${out} (${list.length} icons)`)
}


// ---------------------------------------------------------------------------------------------
// CLI: only when this file is the entry point, so tests can import the functions above.

function isEntry() {
  if (!process.argv[1]) return false
  const norm = (p) => {
    const real = fs.realpathSync(p)
    return process.platform === "win32" ? real.toLowerCase() : real
  }
  try {
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "lint") process.exit(lint() ? 0 : 1)
  else if (command === "build") build()
  else if (command === "dist") dist()
  else if (command === "sheet") await sheet(rest)
  else if (command === "audit") await audit(rest)
  else {
    console.log("usage: icons.mjs lint | build | dist | sheet [names...] [--dark] [--out=file.png] | audit [names...] [--all]")
    process.exit(1)
  }
}
