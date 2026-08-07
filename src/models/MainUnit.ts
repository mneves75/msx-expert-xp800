/**
 * Main unit — Gradiente Expert XP-800 "CONSOLE MOD. C-1".
 *
 * The hero object: a low, wide, hi-fi-styled slab with a stepped two-tone front,
 * two cartridge bays behind spring-loaded dust covers, and a densely silkscreened
 * back panel. Dimensions and labels come from `docs/SPEC.md` §2; everything else
 * was measured off `reference/raw/CF3000_and_XP800.jpg` and
 * `reference/raw/Gradiente_expert_XP-800_back.jpg`.
 *
 * Construction rules that matter for the look:
 *  - Every outer vertical edge is a *real* 5.5 mm fillet, measured from the
 *    reference front elevation and produced by extruding a
 *    rounded-rectangle profile along Y (`extrudedBox`). No fillet is faked with a
 *    normal map — sharp unfilleted edges are the single biggest CG tell.
 *  - The upper shell overhangs the fascia by 3 mm, so the fascia lives in the
 *    shell's contact shadow. That thin dark line is a signature read of the object.
 *  - Silkscreen is a separate, slightly raised decal layer (SPEC §4), never baked
 *    into the substrate albedo.
 *  - Case plastic always comes from `ctx.materials`. Locally built materials are
 *    limited to decal layers, lenses and label stock, which the library does not
 *    cover.
 */

import * as THREE from 'three'

import { yieldToMain } from '../core/cooperative'
import {
  mergeGeometries,
  mergeVertices,
  toCreasedNormals,
} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { PALETTE } from '../core/Materials'
import { catenary } from '../interaction/Physics'
import { createRng, silkscreenDecalAsync, type DecalMaps } from '../textures/procedural'
import type { InteractiveUserData, ModuleContext, SceneModule } from '../core/types'

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Millimetres → metres. Every literal below is written in mm for readability. */
const mm = (v: number): number => v / 1000

// ---------------------------------------------------------------------------
// Master dimensions (SPEC §2)
// ---------------------------------------------------------------------------

const BODY_W = mm(400)
const BODY_D = mm(305)
const FOOT_H = mm(6)

/**
 * Fascia band, recalibrated from the original 34 mm estimate now recorded in SPEC §2.
 *
 * Measured off `CF3000_and_XP800.jpg`: the front elevation is dominated by the
 * black panel, with only a thin brown lid lip above it — the black band runs
 * ~68 % of the 92 mm height, not 37 %. Getting this ratio wrong is what makes a
 * render read as a generic 1980s AV component instead of specifically an XP-800,
 * so the photograph wins over the spec table here.
 */
const FASCIA_H = mm(61)
/** The lid overhangs the black panel by this much. SPEC §2's "signature" shadow line. */
const FASCIA_RECESS = mm(3)

/**
 * Nominal upper-shell (lid) height before the rear rise is sheared in. The rise
 * drops the front lip by REAR_RISE / 2, so the *visible* front band is ~27 mm.
 */
const SHELL_H = mm(31)

/**
 * Rear rise. SPEC calls for ~1.5° across the 305 mm depth (≈8 mm). It is applied
 * as a shear pivoting about the shell's mid-depth, so the body reads 92 mm tall
 * overall: 88 mm at the front lip, 96 mm at the back.
 */
const REAR_RISE = BODY_D * Math.tan((1.5 * Math.PI) / 180)

const Y_BODY_BOTTOM = FOOT_H
const Y_FASCIA_TOP = Y_BODY_BOTTOM + FASCIA_H
const Y_SHELL_TOP_NOMINAL = Y_FASCIA_TOP + SHELL_H

/**
 * Z planes, front positive. Four distinct depths across the front elevation —
 * that stepping is what produces the value ladder the reference photograph has
 * (mid-value lid → blown lip highlight → near-black panel):
 *
 *   Z_SHELL_FRONT        lid, the frontmost plane
 *   Z_RAIL_FRONT         −0.5 mm  case rail + the plain right-hand block
 *   Z_FASCIA_FRONT       −3.0 mm  the black insert panel
 *   Z_CHASSIS_FRONT      −9.0 mm  chassis moulding the panel is set into
 *
 * The chassis has to clear the *deepest* front feature, not just the panel: the
 * cartridge recess floor lands at −5.5 mm and the POWER strip floor at −4.5 mm.
 * Leave the chassis too far forward and its brown front face shows through every
 * opening in the panel, which is exactly how a near-black cartridge bay ends up
 * rendering as light brown.
 */
const Z_SHELL_FRONT = BODY_D / 2
const Z_RAIL_FRONT = Z_SHELL_FRONT - mm(0.5)
const Z_FASCIA_FRONT = Z_SHELL_FRONT - FASCIA_RECESS
const Z_CHASSIS_FRONT = Z_SHELL_FRONT - mm(9)
const Z_BACK_OUTER = -BODY_D / 2
const Z_PLATE_FACE = Z_BACK_OUTER + mm(2)
const Z_BODY_BACK = Z_BACK_OUTER + mm(4)

/**
 * Fillets. Non-uniform on purpose: a moulded ABS shell never carries one radius
 * on every edge, and "same bevel everywhere" is the fastest read that a form was
 * modelled rather than tooled. Vertical corners are generous, the horizontal lid
 * edges much tighter, the fascia lip tighter still.
 */
const CORNER_R = mm(5.5)
const LID_EDGE_BEVEL = mm(1.4)
const LIP_FILLET = mm(1)
/** Side-wall draft, degrees. Mould release taper — the walls are not parallel. */
const DRAFT_DEG = 1.2

/** Back plate opening. */
const PLATE_W = mm(394)
const PLATE_H = mm(84)
const Y_PLATE_TOP = mm(93)
const Y_FRAME_TOP = mm(102)

// --- Front fascia layout, millimetres from the left edge / from the fascia top.
// Every number is measured off `CF3000_and_XP800.jpg`; see FASCIA_H above.

/** The black insert panel stops here; the rest of the front is plain case moulding. */
const PANEL_R_MM = 290
/** Inset of the panel inside the case rail. */
const PANEL_INSET = mm(1.6)

/** Recessed cartridge zone, with the signature diagonal leading edge on its left. */
const RECESS = {
  xTop: 58,
  xBottom: 86,
  xRight: 286,
  yTop: 13,
  yBottom: 55,
  depth: mm(2.5),
} as const

/** Cartridge bays inside the recess. */
const COVER_W = mm(106)
const COVER_H = mm(29)
const BAY_A_X_MM = 62
const BAY_B_X_MM = 176
/** Fascia-local Y of the cover's top edge, in mm measured down from the fascia top. */
const COVER_TOP_MM = 22
/** Cover front face, in the hinge pivot's local frame (recess floor at z = 0). */
const COVER_FACE_Z = mm(2.5) - mm(0.8)

/** Glossy recessed POWER strip. */
const POWER_STRIP = { x0: 4, x1: 56, y0: 13, y1: 27, depth: mm(1.5) } as const

/** Ten pushbuttons, 2 rows × 5 columns, in a shallow bezel. */
const BUTTONS = {
  bezel: { x0: 8, x1: 42, y0: 32, y1: 52 },
  x0: 10.6,
  pitch: 5.6,
  capW: 4.5,
  capH: 2.5,
  rowY: [39.4, 46.2],
  proud: mm(0.8),
} as const

/**
 * UV scale for the case grain: one texture tile every 10 mm of surface.
 *
 * The pebble field's coarse Worley cell is ~18 px of a 1024² map, so a 10 mm tile
 * puts the grain cell at **0.176 mm** — inside the 0.10–0.40 mm band real
 * Mold-Tech tooling grain occupies. The previous 0.4 m tile put it at 2.0 mm,
 * which is why every plastic surface read as pebbled vinyl rather than ABS.
 */
const GRAIN_TILE = 0.01

/** UV scale: planar projection unit for the case geometry. */
const UV_SCALE = 0.4

/**
 * Back-plate paint albedo. Warm khaki-silver, NOT a cool grey.
 *
 * The reference plate samples srgb(178,179,161) lit / srgb(140,143,122) shaded —
 * R ≈ G with B suppressed ~12 %, hue ≈ 65°. The rim strip is the only strong
 * source reaching this face, so a neutral albedo drifts cool here; the value is
 * biased warm to land the *rendered* pixel on R ≥ G > B with B/R ≈ 0.89 —
 * verified by sampling the render, not the swatch.
 *
 * Luminance is the part that matters for legibility. The r2 value (0xd0ceb4,
 * 0.62 linear) was a bright-paint fudge that compensated for the dim rear light,
 * and it cost the whole panel: silkscreen ink tops out near 0.8 linear, so a
 * 0.62 plate leaves the legends at 1.05× the background — measured p95 113 over
 * a plate median of 107, which is *invisible*. The reference plate is a real
 * mid-grey paint (0.40 linear against near-white ink, ~1.7× on the photo), so
 * the albedo drops to that and the contrast comes back. Hue ratios unchanged.
 */
const PLATE_ALBEDO = 0xaba995

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/** Front-face X from a millimetre offset measured left→right as photographed. */
const fx = (v: number): number => -BODY_W / 2 + mm(v)
/** Fascia-band Y from a millimetre offset measured down from the fascia top. */
const fy = (v: number): number => Y_FASCIA_TOP - mm(v)
/** Back-plate X, millimetres left→right *as seen from behind*. */
const bx = (v: number): number => PLATE_W / 2 - mm(v)
/** Back-plate Y, millimetres down from the plate's top edge. */
const by = (v: number): number => Y_PLATE_TOP - mm(v)

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Rounded rectangle as a `Shape`, centred on `(cx, cy)` in its own plane. */
function roundedRectShape(w: number, h: number, r: number, cx = 0, cy = 0): THREE.Shape {
  const radius = Math.min(r, w / 2, h / 2)
  const x = w / 2
  const y = h / 2
  const s = new THREE.Shape()
  s.moveTo(cx - x + radius, cy - y)
  s.lineTo(cx + x - radius, cy - y)
  s.absarc(cx + x - radius, cy - y + radius, radius, -Math.PI / 2, 0, false)
  s.lineTo(cx + x, cy + y - radius)
  s.absarc(cx + x - radius, cy + y - radius, radius, 0, Math.PI / 2, false)
  s.lineTo(cx - x + radius, cy + y)
  s.absarc(cx - x + radius, cy + y - radius, radius, Math.PI / 2, Math.PI, false)
  s.lineTo(cx - x, cy - y + radius)
  s.absarc(cx - x + radius, cy - y + radius, radius, Math.PI, 1.5 * Math.PI, false)
  return s
}

/** Same outline as a `Path`, for use as an extrusion hole. */
function roundedRectPath(w: number, h: number, r: number, cx = 0, cy = 0): THREE.Path {
  const shape = roundedRectShape(w, h, r, cx, cy)
  const p = new THREE.Path()
  p.curves = shape.curves
  p.autoClose = true
  return p
}

/** Circular outline as a `Path`, for use as an extrusion hole. */
function circlePath(r: number, cx: number, cy: number): THREE.Path {
  const p = new THREE.Path()
  p.absarc(cx, cy, r, 0, Math.PI * 2, false)
  p.autoClose = true
  return p
}

/**
 * Planar UV projection, one tile every `scale` metres, chosen per triangle from
 * the geometric normal. Per-triangle (not per-vertex) so a triangle straddling a
 * fillet never tears. Returns a non-indexed geometry.
 */
function planarUV(input: THREE.BufferGeometry, scale = UV_SCALE): THREE.BufferGeometry {
  const geo = input.index === null ? input : input.toNonIndexed()
  const pos = geo.getAttribute('position')
  const count = pos.count
  const uv = new Float32Array(count * 2)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const n = new THREE.Vector3()

  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, i)
    b.fromBufferAttribute(pos, i + 1)
    c.fromBufferAttribute(pos, i + 2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    n.crossVectors(ab, ac)
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    // 0 = project on ZY (facing X), 1 = XZ (facing Y), 2 = XY (facing Z)
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c
      const u = axis === 0 ? p.z : p.x
      const v = axis === 1 ? p.z : p.y
      uv[(i + k) * 2] = u / scale
      uv[(i + k) * 2 + 1] = v / scale
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

/** Normalise any primitive into the merge-compatible shape (non-indexed, planar UVs). */
function prep(geo: THREE.BufferGeometry, scale = UV_SCALE): THREE.BufferGeometry {
  const out = planarUV(geo, scale)
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name)
  }
  out.clearGroups()
  return out
}

interface ExtrudedBoxOptions {
  /** Radius of the four vertical fillets. */
  readonly cornerRadius: number
  /** Chamfer/round applied to the top and bottom horizontal edges. */
  readonly edgeBevel: number
  readonly curveSegments?: number
  readonly bevelSegments?: number
  /** Crease angle for normal smoothing, degrees. */
  readonly creaseDeg?: number
}

/**
 * A box whose four vertical edges carry a true radius. Built by extruding a
 * rounded-rectangle profile (in XZ) along Y, with a bevel closing the top and
 * bottom. Result is centred on the origin, `w × h × d`.
 *
 * three.js ships `RoundedBoxGeometry`, but it rounds every edge with one radius
 * and gives no control over the profile density, which is exactly what a case
 * moulding needs. Hence this helper.
 */
function extrudedBox(
  w: number,
  h: number,
  d: number,
  opts: ExtrudedBoxOptions,
): THREE.BufferGeometry {
  const bevel = Math.min(opts.edgeBevel, h / 2 - 1e-5)
  const shape = roundedRectShape(w - 2 * bevel, d - 2 * bevel, Math.max(opts.cornerRadius - bevel, 1e-4))
  let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: opts.bevelSegments ?? 3,
    curveSegments: opts.curveSegments ?? 6,
    steps: 1,
  })
  // Shape plane (XY, extruded +Z) → world (XZ profile, extruded +Y).
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, bevel - h / 2, 0)
  geo.deleteAttribute('normal')
  geo.deleteAttribute('uv')
  geo = mergeVertices(geo, 1e-6)
  geo = toCreasedNormals(geo, THREE.MathUtils.degToRad(opts.creaseDeg ?? 46))
  return prep(geo)
}

/** Axis-aligned box positioned by its centre. */
function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return prep(g)
}

/** Cylinder lying along Z (i.e. sticking out of a vertical panel). */
function cylZ(
  rTop: number,
  rBottom: number,
  len: number,
  x: number,
  y: number,
  zFace: number,
  segments = 24,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, segments, 1, false)
  g.rotateX(Math.PI / 2)
  // `zFace` is the outward (−Z) face of the port; grow inward from there.
  g.translate(x, y, zFace + len / 2)
  return prep(g)
}

/** Disc facing −Z, used for recessed connector faces and pin fields. */
function discZ(r: number, x: number, y: number, z: number, segments = 24): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, segments)
  g.rotateY(Math.PI)
  g.translate(x, y, z)
  return prep(g)
}

/**
 * Turns a surface inside out: winding is reversed *and* normals are negated, so
 * the result shades correctly when you are looking at what used to be its back.
 * This is what makes a bore read as a hole rather than as a peg.
 */
function invert(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index === null ? geo : geo.toNonIndexed()
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')
  for (let i = 0; i < pos.count; i += 3) {
    const bx1 = pos.getX(i + 1)
    const by1 = pos.getY(i + 1)
    const bz1 = pos.getZ(i + 1)
    pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2))
    pos.setXYZ(i + 2, bx1, by1, bz1)
    if (nor !== undefined) {
      const nx1 = nor.getX(i + 1)
      const ny1 = nor.getY(i + 1)
      const nz1 = nor.getZ(i + 1)
      nor.setXYZ(i + 1, nor.getX(i + 2), nor.getY(i + 2), nor.getZ(i + 2))
      nor.setXYZ(i + 2, nx1, ny1, nz1)
    }
  }
  if (nor !== undefined) {
    for (let i = 0; i < nor.count; i++) {
      nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i))
    }
    nor.needsUpdate = true
  }
  pos.needsUpdate = true
  return g
}

/**
 * Inward-facing cylindrical wall — the side of a drilled hole. `zFace` is the
 * mouth; the bore runs `len` further into the panel (towards +Z).
 */
function boreZ(
  r: number,
  len: number,
  x: number,
  y: number,
  zFace: number,
  segments = 20,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, segments, 1, true)
  g.rotateX(Math.PI / 2)
  g.translate(x, y, zFace + len / 2)
  return prep(invert(g))
}

/**
 * Open-ended cylinder along Z — a tube wall with no end caps.
 *
 * `cylZ` is capped, and a cap on a connector flange sits flat across the mouth
 * and hides everything inside it. That is precisely how the first rebuild of the
 * DIN sockets ended up back at "featureless black disc" despite having a bore, a
 * shield ring, an insulator and thirteen pin sockets modelled behind it.
 */
function tubeZ(
  rFar: number,
  rNear: number,
  len: number,
  x: number,
  y: number,
  zFace: number,
  segments = 24,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rFar, rNear, len, segments, 1, true)
  g.rotateX(Math.PI / 2)
  g.translate(x, y, zFace + len / 2)
  return prep(g)
}

/**
 * The two long walls of a punched louvre, lined in cavity black.
 *
 * The plate's own extrusion walls carry the *painted plate* material, so under a
 * grazing key they render brighter than the plate face and every slot reads as a
 * bright-edged groove instead of a hole — the "flat dark bars with a single bright
 * left wall" the review measured. Real louvres are the darkest thing on the panel:
 * their walls see almost no sky. Two 0.16 mm blades set just inside the bore fix
 * the value without touching the plate's own tooling.
 */
function slotWalls(
  w: number,
  h: number,
  depth: number,
  x: number,
  y: number,
  zFace: number,
): THREE.BufferGeometry[] {
  const t = mm(0.16)
  const z = zFace + depth / 2
  return [
    boxAt(t, h, depth, x - w / 2 + t / 2, y, z),
    boxAt(t, h, depth, x + w / 2 - t / 2, y, z),
    boxAt(w, t, depth, x, y + h / 2 - t / 2, z),
  ]
}

/** Flat annulus facing −Z: connector flanges, washers, chassis-nut rings. */
function ringZ(
  rInner: number,
  rOuter: number,
  x: number,
  y: number,
  z: number,
  segments = 24,
): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(rInner, rOuter, segments)
  g.rotateY(Math.PI)
  g.translate(x, y, z)
  return prep(g)
}

function mergeAll(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  const merged = mergeGeometries(parts as THREE.BufferGeometry[], false)
  for (const p of parts) p.dispose()
  return merged
}

// ---------------------------------------------------------------------------
// Canvas 2D helpers for the silkscreen / label artwork
// ---------------------------------------------------------------------------

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif'

interface TextOptions {
  readonly size: number
  readonly weight?: string
  /** Extra letter spacing, in pixels. Gradiente's silkscreen is widely tracked. */
  readonly tracking?: number
  readonly align?: 'left' | 'center' | 'right'
  /** Horizontal squeeze; < 1 gives the condensed grotesk of the real panel. */
  readonly condense?: number
  readonly color?: string
  readonly italic?: boolean
}

function measureText(ctx: CanvasRenderingContext2D, str: string, o: TextOptions): number {
  const condense = o.condense ?? 1
  const tracking = o.tracking ?? 0
  ctx.font = `${o.italic === true ? 'italic ' : ''}${o.weight ?? 'normal'} ${o.size}px ${SANS}`
  let total = 0
  for (const ch of str) total += ctx.measureText(ch).width * condense + tracking
  return total - tracking
}

/** Draws `str` with manual tracking and optional condensing. Returns its width. */
function drawText(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  o: TextOptions,
): number {
  const condense = o.condense ?? 1
  const tracking = o.tracking ?? 0
  const width = measureText(ctx, str, o)
  const align = o.align ?? 'left'
  let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x
  const previous = ctx.fillStyle
  if (o.color !== undefined) ctx.fillStyle = o.color
  ctx.font = `${o.italic === true ? 'italic ' : ''}${o.weight ?? 'normal'} ${o.size}px ${SANS}`
  for (const ch of str) {
    const w = ctx.measureText(ch).width
    ctx.save()
    ctx.translate(cursor, y)
    ctx.scale(condense, 1)
    ctx.fillText(ch, 0, 0)
    ctx.restore()
    cursor += w * condense + tracking
  }
  ctx.fillStyle = previous
  return width
}

/** Rounded-rectangle path. Hand-rolled: `ctx.roundRect` is not universally typed. */
function rrPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

interface GroupBoxOptions {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly radius: number
  readonly lineWidth: number
  readonly label: readonly string[]
  readonly labelSize: number
  /** Where the label interrupts the outline, in px from `x`. */
  readonly labelX: number
  /** Which edge the label sits on. */
  readonly edge?: 'top' | 'bottom'
  readonly tracking?: number
  readonly condense?: number
  /** Gradiente's panel legends are a bold condensed grotesk, never book weight. */
  readonly weight?: string
}

/**
 * The panel's characteristic group outline: a rounded rectangle whose top (or
 * bottom) rule is interrupted by its legend. Drawn by stroking the full outline
 * and punching the legend's footprint back out, which keeps the joins clean.
 */
function groupBox(ctx: CanvasRenderingContext2D, o: GroupBoxOptions): void {
  const edge = o.edge ?? 'top'
  const lineY = edge === 'top' ? o.y : o.y + o.h
  ctx.save()
  ctx.lineWidth = o.lineWidth
  rrPath(ctx, o.x, o.y, o.w, o.h, o.radius)
  ctx.stroke()

  const opts: TextOptions = {
    size: o.labelSize,
    weight: o.weight ?? '700',
    tracking: o.tracking ?? o.labelSize * 0.07,
    condense: o.condense ?? 0.9,
  }
  let widest = 0
  for (const line of o.label) widest = Math.max(widest, measureText(ctx, line, opts))

  const pad = o.labelSize * 0.34
  const blockH = o.labelSize * 1.18 * o.label.length
  // Top legends hang above their rule; bottom legends drop below it.
  const top = edge === 'top' ? lineY - blockH + o.labelSize * 0.28 : lineY - o.labelSize * 0.24
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.fillRect(o.x + o.labelX - pad, top - o.labelSize * 0.2, widest + pad * 2, blockH + o.labelSize * 0.3)
  ctx.restore()

  ctx.save()
  for (let i = 0; i < o.label.length; i++) {
    const line = o.label[i]
    if (line === undefined) continue
    drawText(ctx, line, o.x + o.labelX, top + o.labelSize * (i + 0.82) * 1.18 - o.labelSize * 0.18, opts)
  }
  ctx.restore()
}

/** Text laid along an arc — the FINAL INSPECTION seal. */
function arcText(
  ctx: CanvasRenderingContext2D,
  str: string,
  cx: number,
  cy: number,
  radius: number,
  centreAngle: number,
  size: number,
  flip: boolean,
): void {
  ctx.save()
  ctx.font = `bold ${size}px ${SANS}`
  ctx.textAlign = 'center'
  let total = 0
  for (const ch of str) total += ctx.measureText(ch).width + size * 0.1
  const span = total / radius
  let angle = centreAngle - (flip ? -span / 2 : span / 2)
  for (const ch of str) {
    const w = ctx.measureText(ch).width + size * 0.1
    const step = w / radius
    angle += flip ? -step / 2 : step / 2
    ctx.save()
    ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
    ctx.rotate(angle + (flip ? -Math.PI / 2 : Math.PI / 2))
    ctx.fillText(ch, 0, 0)
    ctx.restore()
    angle += flip ? -step / 2 : step / 2
  }
  ctx.restore()
}

/**
 * The `⊚gradiente` badge: a ring enclosing a two-turn spiral, then the wordmark
 * in a heavy geometric lowercase (`reference/raw/Gradiente_Logo_Detail.jpg`).
 * Drawn from `x` at cap-height `size`; returns the total width.
 */
function gradienteBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseline: number,
  size: number,
): number {
  const r = size * 0.66
  const cy = baseline - size * 0.36
  const cx = x + r
  ctx.save()
  // Three heavy concentric arcs, not a hairline spiral: on the real badge the
  // mark reads as a *solid* roundel with a dark eye, and a thin crescent renders
  // as a plain lower-case "c" at silkscreen size.
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  // Two thin cuts leave three fat rings; the gap rotates so the rings connect
  // into one continuous stroke, exactly as in Gradiente_Logo_Detail.jpg.
  ctx.lineWidth = Math.max(1, r * 0.14)
  ctx.beginPath()
  const steps = 72
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = -Math.PI * 0.42 + t * 2.1 * Math.PI * 2
    const rr = r * (0.86 - 0.54 * t)
    const px = cx + Math.cos(a) * rr
    const py = cy + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  // The dark eye at the centre.
  ctx.beginPath()
  ctx.arc(cx - r * 0.06, cy, r * 0.17, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Reference: the wordmark starts almost against the roundel — a tenth of the
  // cap height, not the quarter-em a naive layout gives.
  const wordX = x + r * 2 + size * 0.1
  const w = drawText(ctx, 'gradiente', wordX, baseline, {
    size: size * 1.16,
    weight: 'bold',
    tracking: -size * 0.035,
    condense: 0.9,
  })
  return r * 2 + size * 0.1 + w
}

/**
 * The MSX logotype, drawn as vector paths.
 *
 * It is *not* a font: the mark is built from heavy angular chevrons — an M as
 * two peaks, an angular S, and an X of two crossed strokes — with mitred joins
 * and a slight forward slant. Substituting a bold italic sans is the single most
 * obvious tell on the cartridge covers, and no installed face is close enough.
 *
 * `cx`/`baseline` position the mark; `size` is its cap height.
 */
function msxLogotype(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseline: number,
  size: number,
  colour: string,
): void {
  const stroke = size * 0.26
  const slant = 0.16
  // Glyph outlines in a unit box: x right, y down from the cap line.
  interface Glyph {
    readonly path: readonly (readonly [number, number])[]
    /** Pen movement after this stroke, in cap heights. */
    readonly advance: number
  }
  const glyphs: readonly Glyph[] = [
    // M — two peaks, drawn bottom-left → up → down → up → down.
    {
      path: [
        [0, 1],
        [0.3, 0.06],
        [0.6, 1],
        [0.9, 0.06],
        [1.2, 1],
      ],
      advance: 1.34,
    },
    // S — angular: flat top bar, long diagonal, flat bottom bar.
    {
      path: [
        [0.94, 0.08],
        [0.1, 0.08],
        [0.78, 0.92],
        [-0.04, 0.92],
      ],
      advance: 1.06,
    },
    // X — two strokes that genuinely cross, so neither gets a mitre at the join.
    {
      path: [
        [0, 0.06],
        [0.92, 1],
      ],
      advance: 0,
    },
    {
      path: [
        [0.92, 0.06],
        [0, 1],
      ],
      advance: 0.92,
    },
  ]
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = stroke
  ctx.lineJoin = 'miter'
  ctx.lineCap = 'butt'
  ctx.miterLimit = 6

  let totalUnits = 0
  for (const g of glyphs) totalUnits += g.advance
  const left = cx - (totalUnits * size) / 2
  let pen = 0
  for (const glyph of glyphs) {
    ctx.beginPath()
    glyph.path.forEach(([gx, gy], k) => {
      // +y is down from the cap line; the slant leans the top of the mark right.
      const px = left + (pen + gx + (1 - gy) * slant) * size
      const py = baseline - size + gy * size
      if (k === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()
    pen += glyph.advance
  }
  ctx.restore()
}

/** Soft grey haze: settled dust, finger smudges, general 41-year-old grime. */
function dustBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  alpha: number,
): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry))
  g.addColorStop(0, `rgba(196,188,172,${alpha})`)
  g.addColorStop(1, 'rgba(196,188,172,0)')
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, ry / Math.max(rx, 1e-3))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Decal artwork — front
// ---------------------------------------------------------------------------

/** Canvas resolutions. Aspect always matches the physical face, so type never stretches. */
const FASCIA_DECAL_PX = { w: 2560, h: 390 } as const // 400 × 61 mm
const RECESS_DECAL_PX = { w: 2048, h: 376 } as const // 228 × 42 mm
const POWER_DECAL_PX = { w: 768, h: 207 } as const // 52 × 14 mm
const BEZEL_DECAL_PX = { w: 768, h: 452 } as const // 34 × 20 mm
const COVER_DECAL_PX = { w: 1024, h: 280 } as const // 106 × 29 mm
// 394 × 84 mm. 4096 px across is the floor for the back panel: below it the
// 0.5 mm silkscreen rules and the accents in ATENÇÃO / INSTRUÇÕES mip-collapse
// into grey mush at any oblique angle.
const BACK_DECAL_PX = { w: 4096, h: 872 } as const
const TOP_DECAL_PX = { w: 1024, h: 780 } as const // 400 × 305 mm

const INK_WHITE = '#E6E3DA'
/**
 * Back-plate silkscreen. Brighter and cooler than the front ink so it keeps a
 * real contrast ratio against the warm khaki plate (reference measures ≈1.6:1;
 * the r1 render managed 1.15:1 and was unreadable).
 */
const INK_BACK = '#FBFAF4'
const INK_BLUE = '#2E7CC8'
const INK_AMBER = '#C9A55E'

/**
 * Illegible micro-legend: at 1.2 mm cap height the pad print on the real machine
 * resolves to nothing but stroke rhythm, so that is exactly what is drawn. No
 * label is invented — inventing one would be worse than printing texture.
 */
function microLegend(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  width: number,
  height: number,
  rng: () => number,
): void {
  let x = cx - width / 2
  const end = cx + width / 2
  ctx.save()
  while (x < end) {
    const glyph = height * (0.45 + rng() * 0.5)
    if (x + glyph > end) break
    ctx.fillRect(x, y, glyph, height)
    x += glyph + height * (0.28 + rng() * 0.3)
  }
  ctx.restore()
}

/**
 * The black insert panel: the `⊚gradiente  PERSONAL COMPUTER` lockup along the
 * top, plus the grime that collects in the lid seam and around the openings.
 *
 * Everything that lives at a *different depth* (POWER strip, cartridge recess,
 * button bezel) gets its own decal plane parked on its own floor, so no legend
 * ever floats a millimetre in front of the surface it is printed on.
 */
function drawFasciaPanel(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
  const s = w / (PANEL_R_MM - 1.6) // px per mm
  const rng = createRng(0x4c1d77)
  ctx.fillStyle = INK_WHITE

  // Lockup sits high on the panel, hard against the lid seam.
  const baseline = 9.6 * s
  const badgeW = gradienteBadge(ctx, 9 * s, baseline, 4.6 * s)
  // Reference: PERSONAL COMPUTER starts ~0.5 em of cap height after the wordmark
  // and is set far tighter than a default tracking would give.
  drawText(ctx, 'PERSONAL COMPUTER', 9 * s + badgeW + 2.3 * s, baseline - 0.3 * s, {
    size: 2.5 * s,
    weight: '600',
    tracking: 0.34 * s,
    condense: 0.8,
  })

  // Dust in the lid seam along the whole top edge, and along the bottom rail.
  for (let i = 0; i < 26; i++) {
    dustBlob(ctx, (i / 25) * w, 0.8 * s, 22 + rng() * 40, 1.4 * s, 0.02)
  }
  for (let i = 0; i < 14; i++) {
    dustBlob(ctx, (i / 13) * w, 58 * s, 26 + rng() * 40, 1.6 * s, 0.016)
  }
}

/** Glossy POWER strip: the legend and its small secondary line beneath. */
function drawPowerStrip(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
  const s = w / (POWER_STRIP.x1 - POWER_STRIP.x0)
  ctx.fillStyle = INK_WHITE
  // Reference: POWER is small and tightly tracked, roughly half the cap height a
  // naive layout gives it, and sits left of the strip's centre.
  drawText(ctx, 'POWER', 16 * s, 6.6 * s, {
    size: 2.4 * s,
    weight: '600',
    tracking: 0.18 * s,
    condense: 0.86,
  })
  const rng = createRng(0x9911ab)
  microLegend(ctx, 21 * s, 9.0 * s, 9 * s, 1.1 * s, rng)
}

/** Micro-legend rows above each button row. */
function drawButtonBezel(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
  const bz = BUTTONS.bezel
  const s = w / (bz.x1 - bz.x0)
  ctx.fillStyle = 'rgba(226,223,214,0.62)'
  const rng = createRng(0x33ce07)
  for (const rowY of BUTTONS.rowY) {
    for (let col = 0; col < 5; col++) {
      const cx = (BUTTONS.x0 - bz.x0 + col * BUTTONS.pitch + BUTTONS.capW / 2) * s
      microLegend(ctx, cx, (rowY - bz.y0 - 3.1) * s, 4.2 * s, 0.9 * s, rng)
    }
  }
}

/**
 * Floor of the cartridge recess: the two blue `CARTRIDGE` label strips, each
 * tapering into a thin rule that terminates in a boxed slot letter.
 *
 * The box is a crisp *square* outline sitting on the end of that rule, tight
 * against the bay — not a rounded badge floating clear of it.
 */
function drawRecess(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
  const s = w / (RECESS.xRight - RECESS.xTop) // px per mm
  const bays: readonly (readonly [number, string])[] = [
    [BAY_A_X_MM, 'A'],
    [BAY_B_X_MM, 'B'],
  ]
  for (const [x0, letter] of bays) {
    // Local millimetres inside the recess.
    const l = x0 - RECESS.xTop
    const r = l + 106
    ctx.fillStyle = INK_BLUE
    ctx.beginPath()
    ctx.moveTo(l * s, 1.6 * s)
    ctx.lineTo((l + 26) * s, 1.6 * s)
    ctx.lineTo((l + 29.5) * s, 3.4 * s)
    ctx.lineTo((r - 8.2) * s, 3.4 * s)
    ctx.lineTo((r - 8.2) * s, 4.5 * s)
    ctx.lineTo(l * s, 4.5 * s)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = INK_WHITE
    drawText(ctx, 'CARTRIDGE', (l + 3.4) * s, 3.8 * s, {
      size: 2.2 * s,
      weight: '600',
      tracking: 0.24 * s,
      condense: 0.8,
    })

    // Square hairline box, scaled to ~1.4× the thin rule's height, terminating
    // the rule rather than floating to its right.
    const boxH = 5.4 * s
    const boxX = (r - 8.2) * s
    const boxY = 0.9 * s
    ctx.save()
    ctx.strokeStyle = INK_WHITE
    ctx.lineWidth = Math.max(1, 0.26 * s)
    ctx.lineJoin = 'miter'
    ctx.strokeRect(boxX, boxY, boxH, boxH)
    ctx.restore()
    drawText(ctx, letter, boxX + boxH / 2, boxY + boxH * 0.79, {
      size: 3.6 * s,
      weight: 'bold',
      align: 'center',
      condense: 0.88,
    })
  }
}

/**
 * Cartridge dust-cover face. Only the `MSX` logotype is printed here — and it is
 * printed in a *dark* grey on dark grey plastic, at roughly 1.5:1 contrast.
 *
 * On the real machine the mark is barely legible: what makes it readable is the
 * specular difference of the raised ink at grazing angles, not albedo. Rendering
 * it as the brightest element on the fascia is backwards.
 */
function drawCoverFace(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const s = w / 106 // px per mm
  msxLogotype(ctx, 56 * s, h * 0.62, 4.0 * s, 'rgba(96,93,88,0.85)')
  // A cover pushed a few thousand times picks up finger grime along the lip.
  dustBlob(ctx, 53 * s, h * 0.92, w * 0.42, 2.4 * s, 0.02)
}

/**
 * Top surface wear. Micro-scratches and an amber service decal — nothing else.
 *
 * The soft 60–100 mm blotches this used to carry read as water staining or a
 * low-resolution dirt bake, not as use. Real ABS does not stain in that pattern;
 * it collects fine directional scuffing from being wiped down, and it collects
 * whatever the service shop stuck to it.
 */
function drawTopWear(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rnd = createRng(0x51f3c7)
  const s = w / 400 // px per mm

  // Fine directional scuffs, front-to-back: how a machine gets wiped down.
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i < 420; i++) {
    const x = rnd() * w
    // Denser towards the front third, where hands and cloths actually land.
    const y = h * (0.35 + Math.pow(rnd(), 0.65) * 0.65)
    const len = 8 + rnd() * 70
    const drift = (rnd() - 0.5) * 10
    ctx.strokeStyle = `rgba(228,224,214,${0.010 + rnd() * 0.016})`
    ctx.lineWidth = 0.5 + rnd() * 0.8
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + drift, y + len)
    ctx.stroke()
  }
  ctx.restore()

  // ── Amber service decal (SPEC §2.2). Reference: a ~45 × 14 mm strip on the
  // top shell, left of centre and about 60 mm back from the front lip, ink long
  // since faded, one corner lifted.
  const sx = 34 * s
  const sy = h - 78 * s
  const sw = 45 * s
  const sh = 13 * s
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate(-0.018)
  ctx.fillStyle = INK_AMBER
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(sw, 0.6)
  ctx.lineTo(sw - 1.5, sh)
  ctx.lineTo(1.2, sh - 0.4)
  ctx.closePath()
  ctx.fill()
  // Sun-bleached: the right end has lost most of its pigment.
  const fade = ctx.createLinearGradient(0, 0, sw, 0)
  fade.addColorStop(0, 'rgba(180,150,96,0)')
  fade.addColorStop(1, 'rgba(196,178,140,0.5)')
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, sw, sh)
  // Illegible remains of the printing.
  ctx.fillStyle = 'rgba(96,70,32,0.42)'
  microLegend(ctx, sw * 0.44, sh * 0.34, sw * 0.66, sh * 0.16, rnd)
  microLegend(ctx, sw * 0.42, sh * 0.62, sw * 0.58, sh * 0.14, rnd)
  ctx.restore()

  // Dust settled against the sticker's raised edges.
  dustBlob(ctx, sx + sw * 0.5, sy + sh + 1.5, sw * 0.55, 3, 0.03)
}

// ---------------------------------------------------------------------------
// Decal artwork — back panel
// ---------------------------------------------------------------------------

/** Vent slot bank descriptors, shared by the artwork and the recess geometry. */
interface VentBank {
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  readonly pitch: number
  readonly slotW: number
  /** Seeds the ±3 % length jitter. Punched slots are never array-modifier perfect. */
  readonly seed: number
}

const VENT_BANKS: readonly VentBank[] = [
  { x0: 1, x1: 157, y0: 2, y1: 16, pitch: 3.7, slotW: 1.7, seed: 0x11a3 },
  // Traced off the reference at 2.6×: the second row does *not* stop under the
  // SPEAKER LEVEL group, it runs on to just short of the earth post.
  { x0: 2, x1: 106, y0: 19, y1: 33, pitch: 3.7, slotW: 1.7, seed: 0x22b7 },
  { x0: 317, x1: 386, y0: 1, y1: 19, pitch: 3.7, slotW: 1.7, seed: 0x33c1 },
  { x0: 296, x1: 312, y0: 39, y1: 41, pitch: 4.2, slotW: 15.6, seed: 0x44d5 },
  { x0: 296, x1: 312, y0: 43, y1: 45, pitch: 4.2, slotW: 15.6, seed: 0x55e9 },
]

/** One punched slot, in plate millimetres. */
interface VentSlot {
  readonly x: number
  readonly y0: number
  readonly y1: number
  readonly w: number
}

/**
 * Expands a bank into individual slots. Length varies ±3 % about the nominal so
 * the bank never reads as a single primitive stamped N times — that perfect
 * regularity is one of the loudest CG tells on a punched steel panel.
 */
function ventSlots(bank: VentBank): VentSlot[] {
  const rng = createRng(bank.seed)
  const cy = (bank.y0 + bank.y1) / 2
  const h = bank.y1 - bank.y0
  const out: VentSlot[] = []
  for (let x = bank.x0; x <= bank.x1 - bank.slotW + 1e-9; x += bank.pitch) {
    const hh = h * (1 + (rng() - 0.5) * 0.06)
    out.push({ x, y0: cy - hh / 2, y1: cy + hh / 2, w: bank.slotW })
  }
  return out
}

/** Round apertures that need a contact-AO halo painted round their mouth. */
interface PortMark {
  readonly x: number
  readonly y: number
  readonly r: number
}

const PORT_MARKS: readonly PortMark[] = [
  { x: 29.5, y: 63, r: 8.4 },
  { x: 54, y: 57, r: 6.4 },
  { x: 54, y: 70.5, r: 6.4 },
  { x: 80, y: 66, r: 9.6 },
  { x: 107, y: 66, r: 9.6 },
  { x: 92, y: 31, r: 5.6 },
  { x: 246, y: 25, r: 10.6 },
  { x: 330, y: 66, r: 5.8 },
  { x: 386, y: 70, r: 6.8 },
]

/** Rectangular apertures — same treatment, different outline. */
const PORT_RECTS: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 161.5, y: 31, w: 96, h: 17 },
  { x: 295, y: 30, w: 54, h: 16 },
  { x: 348, y: 65, w: 15, h: 29 },
  { x: 367, y: 65, w: 15, h: 29 },
]

/**
 * Grime, oxidation and contact occlusion, painted *under* the silkscreen.
 *
 * This is the layer the reference plate is drowning in and the render had none
 * of: dark staining along the bottom edge, a soot halo at the mouth of every
 * aperture (which reads as the contact AO no SSAO radius is small enough to
 * catch), oxidation bleeding out of the earth post and out of every screw, and
 * dust settled in the bottom third of the vent slots.
 */
function paintPanelGrime(ctx: CanvasRenderingContext2D, s: number, w: number, h: number): void {
  const smudge = (cx: number, cy: number, rx: number, ry: number, a: number, tint: string): void => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, `rgba(${tint},${a})`)
    g.addColorStop(0.55, `rgba(${tint},${(a * 0.45).toFixed(3)})`)
    g.addColorStop(1, `rgba(${tint},0)`)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(rx, ry)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // Bottom-edge staining: 40 years of dust washing down the plate.
  const wash = ctx.createLinearGradient(0, h * 0.7, 0, h)
  wash.addColorStop(0, 'rgba(22,22,18,0)')
  wash.addColorStop(1, 'rgba(22,22,18,0.26)')
  ctx.fillStyle = wash
  ctx.fillRect(0, h * 0.7, w, h * 0.3)

  // Contact occlusion + plug-scuff halo at every aperture.
  for (const p of PORT_MARKS) {
    smudge(p.x * s, p.y * s, p.r * 1.9 * s, p.r * 1.9 * s, 0.30, '16,16,13')
  }
  for (const r of PORT_RECTS) {
    smudge(r.x * s, r.y * s, (r.w * 0.75) * s, (r.h * 1.5) * s, 0.26, '16,16,13')
  }

  // The earth post is the one place bare steel meets paint — it rusts outward.
  smudge(92 * s, 31 * s, 10 * s, 8 * s, 0.22, '74,48,24')

  // Blotchy paint mottling: the plate is never one flat value.
  const rng = createRng(0x5ad10c)
  for (let i = 0; i < 90; i++) {
    const cx = rng() * w
    const cy = rng() * h
    smudge(cx, cy, (6 + rng() * 26) * s, (4 + rng() * 14) * s, 0.05 + rng() * 0.07, '26,26,22')
  }

  // Dust in the bottom third of every slot, plus a dark lip at the mouth.
  for (const bank of VENT_BANKS) {
    for (const slot of ventSlots(bank)) {
      const sh = slot.y1 - slot.y0
      ctx.fillStyle = 'rgba(148,146,128,0.12)'
      ctx.fillRect(slot.x * s, (slot.y1 - sh * 0.3) * s, slot.w * s, sh * 0.3 * s)
      ctx.fillStyle = 'rgba(16,14,10,0.28)'
      ctx.fillRect((slot.x - 0.25) * s, (slot.y0 - 0.25) * s, (slot.w + 0.5) * s, 0.5 * s)
      ctx.fillRect((slot.x - 0.25) * s, (slot.y1 - 0.25) * s, (slot.w + 0.5) * s, 0.5 * s)
    }
  }

  // Horizontal micro-scratch band: only ever seen at grazing incidence.
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i < 260; i++) {
    const x = rng() * w
    const y = rng() * h
    const len = (4 + rng() * 40) * s
    ctx.strokeStyle = `rgba(232,228,214,${(0.02 + rng() * 0.05).toFixed(3)})`
    ctx.lineWidth = 0.4 + rng() * 0.9
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + len, y + len * 0.17)
    ctx.stroke()
  }
  ctx.restore()

  // Rub-through where hands grip the plate edges: paint thins, albedo lifts.
  const edge = ctx.createLinearGradient(0, 0, 0, h)
  edge.addColorStop(0, 'rgba(226,222,206,0.10)')
  edge.addColorStop(0.12, 'rgba(226,222,206,0)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, w, h)
}

/** Oxidation halo bleeding into the paint around a chassis screw head. */
function rustRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const g = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.7)
  g.addColorStop(0, 'rgba(104,64,32,0.20)')
  g.addColorStop(1, 'rgba(104,64,32,0)')
  ctx.save()
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Plate-millimetre positions of every chassis screw, shared with the geometry. */
const PANEL_SCREWS: readonly { x: number; y: number; r: number }[] = [
  { x: 4, y: 50, r: 2.4 },
  { x: 4, y: 76, r: 2.4 },
  { x: 390, y: 60, r: 2.4 },
  { x: 390, y: 78, r: 2.4 },
  { x: 197, y: 79, r: 2.4 },
  { x: 80, y: 52.5, r: 1.9 },
  { x: 107, y: 52.5, r: 1.9 },
  { x: 230, y: 25, r: 2.1 },
  { x: 262, y: 25, r: 2.1 },
  { x: 359, y: 42.5, r: 2.1 },
  { x: 389, y: 42.5, r: 2.1 },
]

/** The full back-panel silkscreen. `w` maps to 394 mm, `h` to 84 mm. */
function drawBackPanel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const s = w / 394
  // SPEC §2.2 rules measure ~0.5 mm on the reference plate; the old 0.24 mm
  // collapsed to sub-pixel the moment the texture mipped down.
  const line = Math.max(1.6, 0.5 * s)
  const rr = 1.4 * s
  const LBL = 3.2 * s

  paintPanelGrime(ctx, s, w, h)

  // INK_BACK, not INK_WHITE: `makeDecal` is handed `ink: INK_BACK` for this
  // layer and pre-sets it on the context, but `paintPanelGrime` above leaves a
  // gradient in `fillStyle`, so it has to be restated — and restating it with
  // the fascia's ink silently threw away the back plate's own, brighter value.
  ctx.fillStyle = INK_BACK
  ctx.strokeStyle = INK_BACK
  ctx.lineWidth = line

  // ── Left audio / video cluster ───────────────────────────────────────────
  groupBox(ctx, {
    x: 19 * s, y: 47 * s, w: 23 * s, h: 32 * s, radius: rr, lineWidth: line,
    label: ['SPEAKER', 'LEVEL'], labelSize: LBL, labelX: 1.5 * s,
  })
  // Travel arc: on the reference this is a broad printed ring segment around the
  // knob, not a hairline — it is the brightest mark in the whole left cluster.
  ctx.save()
  ctx.lineWidth = 1.5 * s
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.arc(29.5 * s, 63 * s, 7.4 * s, Math.PI * 0.12, Math.PI * 0.88, false)
  ctx.stroke()
  ctx.restore()
  drawText(ctx, '−', 22.6 * s, 76.2 * s, { size: 3.6 * s, weight: '700', align: 'center' })
  drawText(ctx, '+', 36.4 * s, 76.4 * s, { size: 3.6 * s, weight: '700', align: 'center' })

  groupBox(ctx, {
    x: 43 * s, y: 47 * s, w: 23 * s, h: 33 * s, radius: rr, lineWidth: line,
    label: ['AUDIO'], labelSize: LBL, labelX: 1.5 * s,
  })
  groupBox(ctx, {
    x: 43 * s, y: 47 * s, w: 23 * s, h: 33 * s, radius: rr, lineWidth: line,
    label: ['VIDEO', 'MONOC'], labelSize: LBL, labelX: 1.5 * s, edge: 'bottom',
  })
  // The reference splits AUDIO from VIDEO MONOC with a rule between the jacks.
  ctx.beginPath()
  ctx.moveTo(43 * s, 63.8 * s)
  ctx.lineTo(66 * s, 63.8 * s)
  ctx.stroke()
  groupBox(ctx, {
    x: 67 * s, y: 47 * s, w: 26 * s, h: 33 * s, radius: rr, lineWidth: line,
    label: ['DATA', 'CORDER'], labelSize: LBL, labelX: 1.5 * s,
  })
  groupBox(ctx, {
    x: 94 * s, y: 47 * s, w: 26 * s, h: 33 * s, radius: rr, lineWidth: line,
    label: ['RGB'], labelSize: LBL, labelX: 1.5 * s,
  })

  // ── Ground post ──────────────────────────────────────────────────────────
  // Centred on the bus connector's own centre line, as on the reference plate.
  drawText(ctx, 'GND', 92 * s, 24.4 * s, {
    size: LBL, weight: '700', tracking: 0.25 * s, condense: 0.9, align: 'center',
  })
  // IEC earth symbol ⏚: stem over three shortening rules.
  ctx.save()
  ctx.lineWidth = line * 1.05
  ctx.beginPath()
  ctx.moveTo(92 * s, 36.2 * s)
  ctx.lineTo(92 * s, 38.6 * s)
  ctx.moveTo(88.2 * s, 38.9 * s)
  ctx.lineTo(95.8 * s, 38.9 * s)
  ctx.moveTo(89.5 * s, 40.5 * s)
  ctx.lineTo(94.5 * s, 40.5 * s)
  ctx.moveTo(90.8 * s, 42.0 * s)
  ctx.lineTo(93.2 * s, 42.0 * s)
  ctx.stroke()
  ctx.restore()

  // ── Bus expansion + the Gradiente-only warning ───────────────────────────
  groupBox(ctx, {
    x: 115 * s, y: 22 * s, w: 96 * s, h: 32 * s, radius: rr, lineWidth: line,
    label: ['BUS EXPANSION'], labelSize: LBL, labelX: 62 * s,
  })
  drawText(ctx, 'ATENÇÃO', 121 * s, 44.6 * s, {
    size: 3.1 * s, weight: '700', tracking: 0.3 * s, condense: 0.92,
  })
  drawText(ctx, 'CONECTE APENAS A EQUIPAMENTOS GRADIENTE.', 141 * s, 44.6 * s, {
    size: 2.9 * s, weight: '600', tracking: 0.14 * s, condense: 0.9,
  })
  drawText(ctx, 'CONSULTE O MANUAL DE INSTRUÇÕES.', 141 * s, 48.9 * s, {
    size: 2.9 * s, weight: '600', tracking: 0.14 * s, condense: 0.9,
  })

  // ── Identity block ───────────────────────────────────────────────────────
  gradienteBadge(ctx, 118 * s, 65.4 * s, 4.6 * s)
  drawText(ctx, 'CONSOLE MOD.', 118 * s, 71.4 * s, {
    size: 3.1 * s, weight: '700', tracking: 0.3 * s, condense: 0.88,
  })
  drawText(ctx, 'INDÚSTRIA BRASILEIRA', 162 * s, 61.6 * s, {
    size: 2.3 * s, weight: '600', tracking: 0.1 * s, condense: 0.9,
  })
  drawText(ctx, 'PRODUZIDO NA ZONA FRANCA DE MANAUS', 162 * s, 65.0 * s, {
    size: 2.3 * s, weight: '600', tracking: 0.1 * s, condense: 0.9,
  })
  drawText(ctx, 'C-1', 202 * s, 71.4 * s, {
    size: 3.4 * s, weight: '700', tracking: 0.2 * s, align: 'right',
  })

  // ── Keyboard input ───────────────────────────────────────────────────────
  groupBox(ctx, {
    x: 222 * s, y: 11 * s, w: 48 * s, h: 28 * s, radius: rr, lineWidth: line,
    label: ['KEYBOARD INPUT'], labelSize: LBL, labelX: 4 * s,
  })

  // ── Parallel printer ─────────────────────────────────────────────────────
  groupBox(ctx, {
    x: 268 * s, y: 19 * s, w: 54 * s, h: 21 * s, radius: rr, lineWidth: line,
    label: ['PARALLEL PRINTER'], labelSize: LBL, labelX: 3 * s,
  })

  // ── Fuse table ───────────────────────────────────────────────────────────
  groupBox(ctx, {
    x: 284 * s, y: 51 * s, w: 52 * s, h: 29 * s, radius: rr, lineWidth: line,
    label: ['FUSE'], labelSize: LBL, labelX: 3 * s,
  })
  const tx = 289 * s
  const ty = 57 * s
  const tw = 31 * s
  const th = 15 * s
  ctx.strokeRect(tx, ty, tw, th)
  ctx.beginPath()
  ctx.moveTo(tx + tw * 0.55, ty)
  ctx.lineTo(tx + tw * 0.55, ty + th)
  ctx.moveTo(tx, ty + th / 2)
  ctx.lineTo(tx + tw, ty + th / 2)
  ctx.stroke()
  const cell: TextOptions = { size: 3.0 * s, weight: '700', align: 'center', condense: 0.9 }
  drawText(ctx, '120V', tx + tw * 0.275, ty + th * 0.36, cell)
  drawText(ctx, '1A', tx + tw * 0.775, ty + th * 0.36, cell)
  drawText(ctx, '240V', tx + tw * 0.275, ty + th * 0.86, cell)
  drawText(ctx, '0,5 A', tx + tw * 0.775, ty + th * 0.86, cell)

  // ── Switched outlet ──────────────────────────────────────────────────────
  groupBox(ctx, {
    x: 339 * s, y: 51 * s, w: 40 * s, h: 29 * s, radius: rr, lineWidth: line,
    label: ['SWITCHED OUTLET'], labelSize: 2.9 * s, labelX: 0.5 * s,
  })
  groupBox(ctx, {
    x: 339 * s, y: 51 * s, w: 40 * s, h: 29 * s, radius: rr, lineWidth: line,
    label: ['MAX. 100W'], labelSize: 2.7 * s, labelX: 2 * s, edge: 'bottom',
  })

  // ── Mains voltage selector ───────────────────────────────────────────────
  groupBox(ctx, {
    x: 354 * s, y: 30 * s, w: 38 * s, h: 17 * s, radius: rr, lineWidth: line,
    label: ['AC INPUT'], labelSize: LBL, labelX: 3 * s,
  })
  drawText(ctx, '120V', 363 * s, 38.8 * s, {
    size: 3.1 * s, weight: '700', align: 'center', condense: 0.9,
  })
  drawText(ctx, '240V', 385 * s, 38.8 * s, {
    size: 3.1 * s, weight: '700', align: 'center', condense: 0.9,
  })

  // ── Aged amber service sticker, bottom band, left of the centre screw ────
  // Reference: an angle-cut strip with sharp corners inside a printed rectangle,
  // sitting on the plate's very bottom edge — not a rounded-corner swatch.
  ctx.save()
  ctx.strokeStyle = 'rgba(226,224,214,0.55)'
  ctx.lineWidth = line * 0.75
  ctx.strokeRect(107 * s, 73.6 * s, 68 * s, 8.2 * s)
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(110.0 * s, 74.8 * s)
  ctx.lineTo(167.0 * s, 74.4 * s)
  ctx.lineTo(172.4 * s, 77.6 * s)
  ctx.lineTo(166.4 * s, 80.7 * s)
  ctx.lineTo(112.6 * s, 80.9 * s)
  // Torn left edge: three small bites out of the paper.
  ctx.lineTo(111.4 * s, 79.4 * s)
  ctx.lineTo(112.4 * s, 78.2 * s)
  ctx.lineTo(110.8 * s, 76.9 * s)
  ctx.closePath()
  ctx.clip()
  ctx.fillStyle = INK_AMBER
  ctx.fillRect(105 * s, 72 * s, 74 * s, 11 * s)
  // Adhesive has yellowed unevenly and darkened at the rim.
  const stain = ctx.createLinearGradient(110 * s, 74 * s, 172 * s, 81 * s)
  stain.addColorStop(0, 'rgba(120,84,30,0.30)')
  stain.addColorStop(0.4, 'rgba(120,84,30,0.05)')
  stain.addColorStop(1, 'rgba(90,60,22,0.34)')
  ctx.fillStyle = stain
  ctx.fillRect(105 * s, 72 * s, 74 * s, 11 * s)
  ctx.restore()
  // Shadow line under the lower-right edge — it has real thickness.
  ctx.save()
  ctx.strokeStyle = 'rgba(20,16,10,0.45)'
  ctx.lineWidth = 0.55 * s
  ctx.beginPath()
  ctx.moveTo(112.8 * s, 81.3 * s)
  ctx.lineTo(166.4 * s, 81.1 * s)
  ctx.lineTo(172.8 * s, 77.8 * s)
  ctx.stroke()
  ctx.restore()

  // ── Oxidation round the fixings ─────────────────────────────────────────
  for (const p of PANEL_SCREWS) rustRing(ctx, p.x * s, p.y * s, p.r * s)

  // ── FINAL INSPECTION seal ────────────────────────────────────────────────
  // Foil label, applied by hand and therefore crooked, with a die-cut rim.
  const cx = 246 * s
  const cy = 50 * s
  const r = 6.6 * s
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.14)
  ctx.translate(-cx, -cy)
  // Scalloped die-cut outline.
  ctx.beginPath()
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2
    const rad = r * (1 + 0.035 * Math.sin(a * 18))
    const px = cx + Math.cos(a) * rad
    const py = cy + Math.sin(a) * rad
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  const foil = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r)
  foil.addColorStop(0, '#5F6266')
  foil.addColorStop(0.55, '#3E4145')
  foil.addColorStop(1, '#212327')
  ctx.fillStyle = foil
  ctx.fill()
  // Spiral rosette centre.
  ctx.strokeStyle = 'rgba(178,182,188,0.75)'
  ctx.lineWidth = Math.max(1, 0.28 * s)
  ctx.beginPath()
  for (let i = 0; i <= 160; i++) {
    const t = i / 160
    const a = t * Math.PI * 2 * 3.4
    const rad = r * (0.10 + 0.42 * t)
    const px = cx + Math.cos(a) * rad
    const py = cy + Math.sin(a) * rad
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  ctx.fillStyle = 'rgba(222,224,228,0.92)'
  arcText(ctx, 'FINAL', cx, cy, r * 0.80, -Math.PI / 2, 2.05 * s, false)
  arcText(ctx, 'INSPECTION', cx, cy, r * 0.84, Math.PI / 2, 2.05 * s, true)
  // Grime over the foil: it is not a fresh label.
  ctx.fillStyle = 'rgba(30,26,16,0.22)'
  ctx.beginPath()
  ctx.arc(cx + r * 0.2, cy + r * 0.3, r * 0.85, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Decal layers
// ---------------------------------------------------------------------------

interface DecalLayer {
  readonly mesh: THREE.Mesh
  readonly maps: DecalMaps
  readonly material: THREE.MeshPhysicalMaterial
}

interface DecalSpec {
  readonly name: string
  /** Physical size of the face the decal sits on, in metres. */
  readonly width: number
  readonly height: number
  readonly px: { readonly w: number; readonly h: number }
  readonly draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  /** Roughness of the substrate underneath; the ink map lowers it locally. */
  readonly substrateRoughness: number
  readonly wear?: number
  readonly relief?: number
  readonly normalScale?: number
  readonly seed?: number
  readonly ink?: string
  /** Texture anisotropy. 16 keeps strokes intact at grazing incidence. */
  readonly anisotropy?: number
}

/**
 * A silkscreen/label layer: real geometry floating 0.15 mm off its substrate,
 * with ink that is slightly raised and slightly glossier than the plastic under
 * it (SPEC §4). Alpha-blended, never depth-writing, so ports that protrude in
 * front of it occlude it correctly.
 */
async function makeDecal(spec: DecalSpec): Promise<DecalLayer> {
  const maps = await silkscreenDecalAsync(spec.draw, {
    width: spec.px.w,
    height: spec.px.h,
    ink: spec.ink ?? INK_WHITE,
    wear: spec.wear ?? 0.16,
    relief: spec.relief ?? 2.6,
    gloss: 0.5,
    seed: spec.seed ?? 0x2b71f5,
  })
  const aniso = spec.anisotropy
  if (aniso !== undefined) {
    for (const tex of [maps.map, maps.normalMap, maps.roughnessMap]) {
      tex.anisotropy = aniso
      tex.needsUpdate = true
    }
  }
  const material = new THREE.MeshPhysicalMaterial({
    name: `decal-${spec.name}`,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: spec.substrateRoughness,
    metalness: 0,
    ior: 1.52,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    dithering: true,
  })
  material.normalScale = new THREE.Vector2(spec.normalScale ?? 0.85, spec.normalScale ?? 0.85)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.height), material)
  mesh.name = `decal-${spec.name}`
  mesh.renderOrder = 2
  mesh.castShadow = false
  mesh.receiveShadow = true
  return { mesh, maps, material }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/**
 * Shears the rear rise into the upper shell: the top plane tilts 1.5° up towards
 * the back, pivoting about mid-depth so the body still reads 92 mm overall. The
 * bottom face is untouched, so it still mates flush with the fascia band.
 *
 * Normals are transported through the inverse-transpose of the local Jacobian
 * rather than recomputed, which keeps the fillet shading intact.
 */
function applyRearRise(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position')
  const nor = geo.getAttribute('normal')
  const k = REAR_RISE
  const invD = 1 / BODY_D
  const n = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const t = (y - Y_FASCIA_TOP) / SHELL_H
    const w = t < 0 ? 0 : t > 1 ? 1 : t
    const inside = t > 0 && t < 1
    pos.setXYZ(i, x, y + w * k * -z * invD, z)

    const b = 1 + (inside ? (1 / SHELL_H) * k * -z * invD : 0)
    const c = -w * k * invD
    n.fromBufferAttribute(nor, i)
    const ny = n.y / b
    n.set(n.x, ny, n.z - c * ny)
    n.normalize()
    nor.setXYZ(i, n.x, n.y, n.z)
  }
  pos.needsUpdate = true
  nor.needsUpdate = true
}

/**
 * Mould-release draft on the side walls: the outer surface tapers `DRAFT_DEG`
 * per side over the height band `[yLo, yHi]`, widest at the bottom (the open end
 * of the tool). It is under a millimetre of movement and you would never measure
 * it by eye — but a shell whose walls are exactly parallel reads as CAD, and one
 * with draft reads as tooling.
 */
function applyDraft(geo: THREE.BufferGeometry, yLo: number, yHi: number): void {
  const pos = geo.getAttribute('position')
  const taper = Math.tan((DRAFT_DEG * Math.PI) / 180)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const t = Math.min(1, Math.max(0, (yHi - y) / Math.max(1e-6, yHi - yLo)))
    const grow = 1 + (taper * (yHi - yLo) * t) / (BODY_W / 2)
    pos.setX(i, pos.getX(i) * grow)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
}

/** Upper lid: warm brown-graphite, full depth, rear rise applied. */
function shellGeometry(): THREE.BufferGeometry {
  const depth = Z_SHELL_FRONT - Z_BODY_BACK
  const g = extrudedBox(BODY_W, SHELL_H, depth, {
    cornerRadius: CORNER_R,
    edgeBevel: LID_EDGE_BEVEL,
    curveSegments: 9,
    bevelSegments: 3,
  })
  g.translate(0, Y_FASCIA_TOP + SHELL_H / 2, (Z_SHELL_FRONT + Z_BODY_BACK) / 2)
  applyRearRise(g)
  return g
}

/** Lower chassis moulding: the sides, the bottom, and everything behind the panel. */
function chassisGeometry(): THREE.BufferGeometry {
  const depth = Z_CHASSIS_FRONT - Z_BODY_BACK
  const g = extrudedBox(BODY_W, FASCIA_H, depth, {
    cornerRadius: CORNER_R,
    edgeBevel: LIP_FILLET,
    curveSegments: 9,
    bevelSegments: 2,
  })
  g.translate(0, Y_BODY_BOTTOM + FASCIA_H / 2, (Z_CHASSIS_FRONT + Z_BODY_BACK) / 2)
  applyDraft(g, Y_BODY_BOTTOM, Y_FASCIA_TOP)
  return g
}

/** Millimetre helper for the panel opening in the chassis rail. */
const PANEL_OPENING = {
  x0: PANEL_INSET,
  x1: mm(PANEL_R_MM),
  yLo: Y_BODY_BOTTOM + PANEL_INSET,
  yHi: Y_FASCIA_TOP - mm(1.2),
} as const

/**
 * The case rail standing proud in front of the chassis: a thin frame on the left
 * and bottom of the black insert, and — the part that actually matters — the
 * **plain moulded block filling the right ~27 % of the front elevation**. That
 * asymmetric mass, controls clustered left of centre with a blank block at the
 * right, is a strong identity cue of the XP-800 and it is plainly visible in
 * `CF3000_and_XP800.jpg`.
 */
function frontRailGeometry(): THREE.BufferGeometry {
  const cy = Y_BODY_BOTTOM + FASCIA_H / 2
  const shape = roundedRectShape(BODY_W, FASCIA_H, CORNER_R, 0, cy)
  const holeW = PANEL_OPENING.x1 - PANEL_OPENING.x0
  const holeH = PANEL_OPENING.yHi - PANEL_OPENING.yLo
  shape.holes.push(
    roundedRectPath(
      holeW,
      holeH,
      mm(1.2),
      -BODY_W / 2 + (PANEL_OPENING.x0 + PANEL_OPENING.x1) / 2,
      (PANEL_OPENING.yLo + PANEL_OPENING.yHi) / 2,
    ),
  )
  const bevel = mm(0.6)
  const depth = Z_RAIL_FRONT - Z_CHASSIS_FRONT
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 7,
    steps: 1,
  })
  g.translate(0, 0, Z_CHASSIS_FRONT)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(44))
  const out = prep(g)
  applyDraft(out, Y_BODY_BOTTOM, Y_FASCIA_TOP)
  return out
}

/** Straight-edged polygon as an extrusion hole. */
function polyPath(points: readonly (readonly [number, number])[]): THREE.Path {
  const p = new THREE.Path()
  const first = points[0]
  if (first === undefined) return p
  p.moveTo(first[0], first[1])
  for (let i = 1; i < points.length; i++) {
    const pt = points[i]
    if (pt !== undefined) p.lineTo(pt[0], pt[1])
  }
  p.autoClose = true
  return p
}

/**
 * The black insert panel, with every opening cut as real geometry:
 *
 *  - the recessed cartridge zone, whose **left edge is the diagonal chamfer**
 *    visible in the reference — the front-panel echo of the keyboard's angled
 *    notch, and a large part of why the real panel does not read as flat;
 *  - the glossy POWER strip recess;
 *  - the shallow bezel the ten pushbuttons sit in.
 *
 * The extrusion bevel gives every one of those edges a fillet, so each picks up
 * its own specular line instead of dying as a painted rectangle.
 */
function fasciaGeometry(): THREE.BufferGeometry {
  const w = PANEL_OPENING.x1 - PANEL_OPENING.x0
  const h = PANEL_OPENING.yHi - PANEL_OPENING.yLo
  const cx = -BODY_W / 2 + (PANEL_OPENING.x0 + PANEL_OPENING.x1) / 2
  const cy = (PANEL_OPENING.yLo + PANEL_OPENING.yHi) / 2
  const shape = roundedRectShape(w, h, mm(1), cx, cy)

  shape.holes.push(
    polyPath([
      [fx(RECESS.xTop), fy(RECESS.yTop)],
      [fx(RECESS.xRight), fy(RECESS.yTop)],
      [fx(RECESS.xRight), fy(RECESS.yBottom)],
      [fx(RECESS.xBottom), fy(RECESS.yBottom)],
    ]),
  )
  shape.holes.push(
    roundedRectPath(
      mm(POWER_STRIP.x1 - POWER_STRIP.x0),
      mm(POWER_STRIP.y1 - POWER_STRIP.y0),
      mm(0.8),
      fx((POWER_STRIP.x0 + POWER_STRIP.x1) / 2),
      fy((POWER_STRIP.y0 + POWER_STRIP.y1) / 2),
    ),
  )
  shape.holes.push(
    roundedRectPath(
      mm(BUTTONS.bezel.x1 - BUTTONS.bezel.x0),
      mm(BUTTONS.bezel.y1 - BUTTONS.bezel.y0),
      mm(0.8),
      fx((BUTTONS.bezel.x0 + BUTTONS.bezel.x1) / 2),
      fy((BUTTONS.bezel.y0 + BUTTONS.bezel.y1) / 2),
    ),
  )

  const bevel = mm(0.9)
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: mm(3) - bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 6,
    steps: 1,
  })
  g.translate(0, 0, Z_FASCIA_FRONT - mm(3))
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(40))
  return prep(g)
}

/** Graphite ring around the recessed back plate — the 2 mm rebate you can see. */
function rearFrameGeometry(): THREE.BufferGeometry {
  const frameH = Y_FRAME_TOP - Y_BODY_BOTTOM
  const frameCy = (Y_FRAME_TOP + Y_BODY_BOTTOM) / 2
  const plateCy = Y_PLATE_TOP - PLATE_H / 2
  const shape = roundedRectShape(BODY_W, frameH, CORNER_R, 0, frameCy)
  shape.holes.push(roundedRectPath(PLATE_W, PLATE_H, mm(1.5), 0, plateCy))
  const bevel = mm(1.2)
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: mm(4),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 5,
    steps: 1,
  })
  g.translate(0, 0, Z_BACK_OUTER + bevel)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(46))
  return prep(g)
}

/**
 * Back plate: the lighter grey moulding, with every vent slot as a real
 * through-hole so the recess walls catch light at grazing angles.
 */
function backPlateGeometry(): THREE.BufferGeometry {
  const plateCy = Y_PLATE_TOP - PLATE_H / 2
  const shape = roundedRectShape(PLATE_W, PLATE_H, mm(1.2), 0, plateCy)
  // Real through-slots with square ends and a 0.3 mm corner break — a punched
  // steel louvre, not a stadium capsule from an array modifier.
  for (const bank of VENT_BANKS) {
    for (const slot of ventSlots(bank)) {
      shape.holes.push(
        roundedRectPath(
          mm(slot.w),
          mm(slot.y1 - slot.y0),
          mm(0.3),
          bx(slot.x + slot.w / 2),
          by((slot.y0 + slot.y1) / 2),
        ),
      )
    }
  }
  // Header apertures. Each shroud drops into its hole with ~2 mm of clearance,
  // so the housing is genuinely seated in the plate instead of glued on top.
  for (const a of HEADER_APERTURES) {
    shape.holes.push(roundedRectPath(mm(a.w), mm(a.h), mm(0.6), bx(a.x), by(a.y)))
  }
  for (const h of PLATE_HOLES) {
    shape.holes.push(circlePath(mm(h.r), bx(h.x), by(h.y)))
  }
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: mm(4),
    bevelEnabled: false,
    curveSegments: 3,
    steps: 1,
  })
  g.translate(0, 0, Z_PLATE_FACE)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(40))
  return prep(g)
}

/** Four soft rubber feet, turned profile with a rounded ground edge. */
function feetGeometry(): THREE.BufferGeometry | null {
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(mm(6.4), 0),
    new THREE.Vector2(mm(8.2), mm(0.7)),
    new THREE.Vector2(mm(9), mm(1.9)),
    new THREE.Vector2(mm(9), mm(4.6)),
    new THREE.Vector2(mm(8.3), mm(5.8)),
    new THREE.Vector2(0, mm(6)),
  ]
  const parts: THREE.BufferGeometry[] = []
  const dx = BODY_W / 2 - mm(34)
  const dz = BODY_D / 2 - mm(34)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.LatheGeometry(profile, 24)
      g.translate(sx * dx, 0, sz * dz)
      parts.push(prep(g, 0.05))
    }
  }
  return mergeAll(parts)
}

// ---------------------------------------------------------------------------
// Back panel hardware
// ---------------------------------------------------------------------------

/** Geometry accumulated per material, merged into one draw call at the end. */
type Bucket = Map<string, THREE.BufferGeometry[]>

function put(bucket: Bucket, key: string, geo: THREE.BufferGeometry): void {
  const list = bucket.get(key)
  if (list === undefined) bucket.set(key, [geo])
  else list.push(geo)
}

/** A cylindrical port standing `out` mm proud of the back plate. */
function portCyl(r: number, out: number, x: number, y: number, segments = 20): THREE.BufferGeometry {
  return cylZ(mm(r), mm(r), mm(out + 2), bx(x), by(y), Z_PLATE_FACE - mm(out), segments)
}

/** Flat face inside a port, `depth` mm behind the plate surface. */
function portFace(r: number, out: number, depth: number, x: number, y: number, segments = 20): THREE.BufferGeometry {
  return discZ(mm(r), bx(x), by(y), Z_PLATE_FACE - mm(out) + mm(depth), segments)
}

/**
 * Pan-head Phillips chassis screw. Domed head, a real cross recess with dark
 * walls, and a countersink shadow ring dished into the paint around it — the
 * three reads that separate a screw from a grey lump at macro distance.
 */
function screw(bucket: Bucket, metalKey: string, x: number, y: number, r: number): void {
  const rim = Z_PLATE_FACE - mm(1.25)
  const crown = Z_PLATE_FACE - mm(1.9)
  // Countersink: the plate dishes very slightly under the head.
  put(bucket, 'deepDark', ringZ(mm(r * 0.98), mm(r * 1.5), bx(x), by(y), Z_PLATE_FACE - mm(0.04), 20))
  // Barrel + dome.
  put(bucket, metalKey, tubeZ(mm(r), mm(r), mm(1.6), bx(x), by(y), rim, 20))
  put(bucket, metalKey, ringZ(mm(r * 0.62), mm(r), bx(x), by(y), rim, 20))
  put(bucket, metalKey, tubeZ(mm(r * 0.62), mm(r * 0.62), mm(0.7), bx(x), by(y), crown, 20))
  put(bucket, metalKey, discZ(mm(r * 0.62), bx(x), by(y), crown, 20))
  // Cross recess: two crossed troughs standing 0.03 mm proud of the crown so
  // they win the depth test instead of z-fighting it, as the old version did.
  const rz = crown - mm(0.03)
  const wide = mm(r * 1.06)
  const narrow = mm(r * 0.26)
  put(bucket, 'deepDark', boxAt(wide, narrow, mm(0.5), bx(x), by(y), rz + mm(0.25)))
  put(bucket, 'deepDark', boxAt(narrow, wide, mm(0.5), bx(x), by(y), rz + mm(0.25)))
}

/**
 * A DIN socket built the way the physical part is: a black moulded flange proud
 * of the plate, a real bore, the bright steel shield ring the shell carries at
 * the mouth, an insulator disc set back inside, drilled pin sockets and the
 * keyway notch at twelve o'clock. Printed dots do not survive this distance.
 */
function dinSocket(
  bucket: Bucket,
  x: number,
  y: number,
  outerR: number,
  pins: readonly { readonly r: number; readonly a: number }[],
): void {
  // 2.4 mm of moulded flange, matching the wide black ring on the reference part.
  const boreR = outerR - 2.4
  const proud = 2.2
  // 3.4 mm, not 5.2: any deeper and the insulator sits in its own shadow and
  // the whole socket collapses back into the featureless black disc it was.
  const depth = 3.4
  const faceZ = Z_PLATE_FACE - mm(proud)
  const insZ = faceZ + mm(depth)

  // Moulded flange, with a chamfer that catches a rim highlight.
  put(bucket, 'dinBody', tubeZ(mm(outerR), mm(outerR), mm(proud + 1.4), bx(x), by(y), faceZ, 32))
  put(bucket, 'dinBody', tubeZ(mm(outerR), mm(outerR - 0.7), mm(0.7), bx(x), by(y), faceZ - mm(0.7), 32))
  put(bucket, 'dinBody', ringZ(mm(boreR), mm(outerR - 0.7), bx(x), by(y), faceZ - mm(0.7), 32))
  put(bucket, 'dinBody', boreZ(mm(boreR), mm(depth + 0.7), bx(x), by(y), faceZ - mm(0.7), 32))
  // Steel shield ring just inside the mouth.
  put(bucket, 'dinShell', ringZ(mm(boreR - 0.35), mm(boreR), bx(x), by(y), faceZ + mm(0.3), 32))
  put(bucket, 'dinShell', boreZ(mm(boreR - 0.35), mm(1.2), bx(x), by(y), faceZ + mm(0.3), 32))
  // Insulator disc.
  put(bucket, 'dinInsert', discZ(mm(boreR), bx(x), by(y), insZ, 32))
  // Keyway slot, cut into the shell at the top of the bore.
  put(
    bucket,
    'deepDark',
    boxAt(mm(2.0), mm(1.4), mm(1.6), bx(x), by(y - (boreR - 0.55)), faceZ + mm(0.9)),
  )
  // Pin sockets: a bright contact sleeve round a drilled bore. The sleeve is
  // what makes 8 or 13 individual pins countable at macro distance.
  for (const pin of pins) {
    const px = x + Math.cos(pin.a) * pin.r
    const py = y + Math.sin(pin.a) * pin.r
    put(bucket, 'dinShell', ringZ(mm(0.52), mm(0.86), bx(px), by(py), insZ - mm(0.04), 12))
    put(bucket, 'deepDark', boreZ(mm(0.52), mm(1.6), bx(px), by(py), insZ - mm(0.04), 10))
    put(bucket, 'deepDark', discZ(mm(0.52), bx(px), by(py), insZ + mm(1.56), 10))
  }
}

/** Pin ring for the DIN 45326 family — an arc opening downwards under the keyway. */
function dinPins(count: number, radius: number, spreadDeg: number): { r: number; a: number }[] {
  const out: { r: number; a: number }[] = []
  const spread = (spreadDeg * Math.PI) / 180
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1)
    out.push({ r: radius, a: Math.PI / 2 + spread * (t - 0.5) })
  }
  return out
}

/** Concentric pin ring, for the 13-way DIN 41524 keyboard connector. */
function dinRing(count: number, radius: number, phase = 0): { r: number; a: number }[] {
  const out: { r: number; a: number }[] = []
  for (let i = 0; i < count; i++) out.push({ r: radius, a: phase + (i / count) * Math.PI * 2 })
  return out
}

/**
 * A shrouded two-row header with ejector latches — the family used for both
 * BUS EXPANSION and PARALLEL PRINTER on the reference plate.
 *
 * Every element is derived from `len`, so the contact field is structurally
 * incapable of running past the housing that contains it (the r1 render had
 * pins floating outside the shroud at the left end). The whole assembly sits in
 * a recessed aperture with a dark gap line round it, and stands only 2.6 mm
 * proud instead of the previous 8 mm.
 */
function shroudedHeader(
  bucket: Bucket,
  cx: number,
  cy: number,
  len: number,
  height: number,
  perRow: number,
  rowGap: number,
): void {
  const proud = 2.6
  const faceZ = Z_PLATE_FACE - mm(proud)
  const wall = 2.2
  const depth = 6.4

  // Dark rebate behind the plate aperture: the gap line round the housing.
  put(
    bucket,
    'deepDark',
    boxAt(mm(len + 4), mm(height + 4), mm(2.6), bx(cx), by(cy), Z_PLATE_FACE + mm(1.4)),
  )

  // Shroud is a *frame*, not a block: a solid box would occlude its own cavity,
  // which is exactly how the first pass ended up with invisible contacts.
  const zMid = faceZ + mm(depth / 2)
  put(bucket, 'dinBody', boxAt(mm(len), mm(wall), mm(depth), bx(cx), by(cy - (height - wall) / 2), zMid))
  put(bucket, 'dinBody', boxAt(mm(len), mm(wall), mm(depth), bx(cx), by(cy + (height - wall) / 2), zMid))
  for (const sx of [-1, 1]) {
    put(
      bucket,
      'dinBody',
      boxAt(mm(wall), mm(height), mm(depth), bx(cx + sx * (len - wall) / 2), by(cy), zMid),
    )
  }
  // Cavity back wall.
  const backZ = faceZ + mm(depth - 0.8)
  put(bucket, 'deepDark', boxAt(mm(len), mm(height), mm(1.6), bx(cx), by(cy), backZ))

  // Pale insulator block the contacts stand on, set back inside the cavity.
  const insW = len - 2 * wall - 1.6
  const insH = height - 2 * wall - 0.8
  const insFace = faceZ + mm(3.0)
  put(bucket, 'connectorBody', boxAt(mm(insW), mm(insH), mm(2.6), bx(cx), by(cy), insFace + mm(1.3)))

  // Brushed shield strip along the top lip.
  put(
    bucket,
    'shellMetal',
    boxAt(mm(len - 2.4), mm(0.9), mm(0.9), bx(cx), by(cy - height / 2 + 0.6), faceZ + mm(0.45)),
  )

  // Flat gold contacts, edge-on. The field is derived from the same `len` as the
  // housing, so a row can never again run past the shroud that contains it.
  const field = insW - 2.4
  const x0 = cx - field / 2
  for (const dy of [-rowGap / 2, rowGap / 2]) {
    for (let i = 0; i < perRow; i++) {
      const px = x0 + (field * (i + 0.5)) / perRow
      put(bucket, 'gold', boxAt(mm(0.85), mm(1.4), mm(2.0), bx(px), by(cy + dy), insFace + mm(0.2)))
    }
  }

  // Ejector latches, inset so nothing overhangs the housing ends.
  for (const sx of [-1, 1]) {
    const lx = cx + sx * (len / 2 - 1.4)
    put(bucket, 'dinBody', boxAt(mm(2.8), mm(height + 4.4), mm(4.0), bx(lx), by(cy), faceZ + mm(2.0)))
    put(
      bucket,
      'dinBody',
      boxAt(mm(1.5), mm(1.8), mm(1.1), bx(lx), by(cy - height / 2 - 1.8), faceZ + mm(0.55)),
    )
  }
}

/**
 * Round plate apertures. Without these the sockets are modelled *into* 4 mm of
 * solid steel: the insulator disc, the pin field and the black bore all end up
 * buried inside the plate and the socket renders as an empty ring.
 */
const PLATE_HOLES: readonly { x: number; y: number; r: number }[] = [
  { x: 54, y: 57, r: 2.5 },
  { x: 54, y: 70.5, r: 2.5 },
  { x: 80, y: 66, r: 5.5 },
  { x: 107, y: 66, r: 5.5 },
  { x: 246, y: 25, r: 6.4 },
]

/**
 * Plate apertures for the two shrouded headers. Cut as real holes so the 2 mm
 * gap round each housing reads as a dark line rather than as a decal.
 */
const HEADER_APERTURES: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 161.5, y: 31, w: 92.4, h: 15.0 },
  { x: 295, y: 30, w: 52.4, h: 13.8 },
]

/**
 * GND: a brass thumb nut, not a faceted lump. Knurl is real geometry because
 * the silhouette is visible at this angle; it sits on a dark steel washer over
 * a short threaded post, and is centred on the bus connector's own centre line.
 */
function groundPost(bucket: Bucket, x: number, y: number): void {
  const wz = Z_PLATE_FACE - mm(0.9)
  put(bucket, 'dark', tubeZ(mm(4.6), mm(4.6), mm(0.9), bx(x), by(y), wz, 26))
  put(bucket, 'dark', ringZ(mm(1.8), mm(4.6), bx(x), by(y), wz, 26))

  const nz = Z_PLATE_FACE - mm(3.9)
  put(bucket, 'brass', cylZ(mm(3.4), mm(3.4), mm(3.0), bx(x), by(y), nz, 32))
  // Dome: `cylZ` puts its first radius at +Z (into the panel), so the crown is
  // the *second* argument. Getting this backwards turns the nut into a funnel.
  put(bucket, 'brass', cylZ(mm(3.4), mm(2.1), mm(0.9), bx(x), by(y), nz - mm(0.9), 32))
  put(bucket, 'brass', discZ(mm(2.1), bx(x), by(y), nz - mm(0.9), 32))
  // 24 knurl flutes round the rim; tarnish darkens their valleys via the map.
  for (let i = 0; i < 24; i++) {
    const g = new THREE.BoxGeometry(mm(0.55), mm(0.8), mm(2.6))
    g.translate(0, mm(3.4), 0)
    g.rotateZ((i / 24) * Math.PI * 2)
    g.translate(bx(x), by(y), nz + mm(1.5))
    put(bucket, 'brass', prep(g, 0.05))
  }
  put(bucket, 'dark', cylZ(mm(1.7), mm(1.7), mm(3.4), bx(x), by(y), nz + mm(3.0), 12))
}

/**
 * Panel-mount RCA. The barrel lives *behind* the plate: only the coloured
 * insulator collar shows, ~3 mm proud, with a black bore and the centre pin
 * recessed inside it. No ribbed chrome battery standing on the panel.
 */
function rcaJack(bucket: Bucket, x: number, y: number, colourKey: string): void {
  const faceZ = Z_PLATE_FACE - mm(3.2)
  // Chassis nut flat on the plate, then the thick black housing rim.
  put(bucket, 'dinBody', ringZ(mm(5.4), mm(6.4), bx(x), by(y), Z_PLATE_FACE - mm(0.05), 32))
  put(bucket, 'dinBody', tubeZ(mm(5.4), mm(5.4), mm(4.2), bx(x), by(y), faceZ, 32))
  put(bucket, 'dinBody', ringZ(mm(4.0), mm(5.4), bx(x), by(y), faceZ, 32))
  // Coloured insulator collar: a 1.6 mm ring, the way a panel-mount RCA actually
  // presents. Everything else the viewer sees is black housing or black bore.
  const collarZ = faceZ + mm(0.4)
  put(bucket, colourKey, tubeZ(mm(4.0), mm(4.0), mm(2.0), bx(x), by(y), collarZ, 32))
  put(bucket, colourKey, ringZ(mm(2.4), mm(4.0), bx(x), by(y), collarZ, 32))
  put(bucket, colourKey, boreZ(mm(2.4), mm(1.6), bx(x), by(y), collarZ, 32))
  // Black bore + recessed centre pin.
  put(bucket, 'deepDark', boreZ(mm(2.3), mm(4.4), bx(x), by(y), collarZ + mm(1.6), 28))
  put(bucket, 'deepDark', discZ(mm(2.3), bx(x), by(y), collarZ + mm(6.0), 28))
  put(bucket, 'chrome', cylZ(mm(0.5), mm(0.5), mm(2.6), bx(x), by(y), collarZ + mm(3.4), 16))
  put(bucket, 'chrome', discZ(mm(0.5), bx(x), by(y), collarZ + mm(3.4), 16))
}

/** Everything that sticks out of, or is drilled into, the back plate. */
function buildBackHardware(bucket: Bucket): {
  readonly knobPivot: THREE.Object3D
  readonly voltageSlider: THREE.Mesh
} {
  // ── Interior seen through the vent slots ─────────────────────────────────
  // Real apertures need something behind them: a dark shell, the edge of the
  // main board, and a loom of coloured wire visible through the upper-left bank.
  // Everything visible through a slot has to live in the 0–2 mm window between
  // the plate's inner face and the upper shell's rear wall (`Z_BODY_BACK` sits at
  // `Z_PLATE_FACE + 2 mm`). Earlier passes parked the loom 6–14 mm in, i.e.
  // *inside* the solid shell, which is why the slots read as opaque grooves.
  put(
    bucket,
    'deepDark',
    boxAt(PLATE_W, PLATE_H, mm(1.2), 0, Y_PLATE_TOP - PLATE_H / 2, Z_PLATE_FACE + mm(2.3)),
  )
  // Cavity-black walls in every louvre, so a slot is a hole and not a groove.
  for (const bank of VENT_BANKS) {
    for (const slot of ventSlots(bank)) {
      for (const wall of slotWalls(
        mm(slot.w),
        mm(slot.y1 - slot.y0),
        mm(2.1),
        bx(slot.x + slot.w / 2),
        by((slot.y0 + slot.y1) / 2),
        Z_PLATE_FACE + mm(0.1),
      )) {
        put(bucket, 'deepDark', wall)
      }
    }
  }

  /**
   * What the louvres actually reveal.
   *
   * Re-traced off the reference at 2.6×, because the r4 pass had this badly wrong:
   * a 126 mm board edge and four full-width wires meant *every* slot in the bank
   * showed the same green at the same height with the same red/blue dashes over
   * it, and the whole left third read as a printed barcode — a louder CG tell than
   * the empty grooves it replaced.
   *
   * On the machine, ~80 % of the bank is black. Content appears in one window
   * (panel-mm 74–128): a pale bundle of mains-side wiring dressed against the
   * shell, three thin colour-coded wires crossing it at an angle, a varnished
   * amber transformer body glimpsed through the lower row, and a sliver of board
   * at the right end. Nothing is horizontal and nothing spans the bank.
   *
   * Everything has to live in the 0.4–2.2 mm window between the plate's inner face
   * and the shell's rear wall (`Z_BODY_BACK` = `Z_PLATE_FACE` + 2 mm); parked any
   * deeper it is inside solid plastic and the slots go opaque again.
   */
  for (const bundle of [
    { key: 'loomPale', x: 96, y: 5.6, len: 34, r: 1.5, tilt: 0.06, z: 1.3 },
    { key: 'loomPale', x: 102, y: 9.2, len: 26, r: 1.3, tilt: -0.09, z: 1.5 },
    { key: 'loomPale', x: 92, y: 12.4, len: 18, r: 1.1, tilt: 0.13, z: 1.2 },
    { key: 'transformer', x: 93, y: 26.5, len: 26, r: 4.2, tilt: 0.0, z: 1.4 },
  ] as const) {
    const g = new THREE.CylinderGeometry(mm(bundle.r), mm(bundle.r), mm(bundle.len), 12, 1, false)
    g.rotateZ(Math.PI / 2 + bundle.tilt)
    g.translate(bx(bundle.x), by(bundle.y), Z_PLATE_FACE + mm(bundle.z))
    put(bucket, bundle.key, prep(g, 0.05))
  }
  // Three thin wires crossing the bundle at a steep angle: what makes the slots
  // reveal *different* content slot to slot instead of one repeated stripe.
  for (const wire of [
    { key: 'wireRed', x: 108, y: 8.0, len: 15, angle: 1.05, z: 0.85 },
    { key: 'wireYellow', x: 116, y: 9.4, len: 13, angle: -0.85, z: 0.95 },
    { key: 'wireGreen', x: 100, y: 10.6, len: 11, angle: 1.25, z: 0.8 },
    { key: 'wireRed', x: 122, y: 11.8, len: 9, angle: -1.15, z: 0.9 },
  ] as const) {
    const g = new THREE.CylinderGeometry(mm(0.7), mm(0.7), mm(wire.len), 8, 1, false)
    g.rotateZ(wire.angle)
    g.translate(bx(wire.x), by(wire.y), Z_PLATE_FACE + mm(wire.z))
    put(bucket, wire.key, prep(g, 0.05))
  }
  // Board sliver at the right end of the upper bank, deep enough to sit in its
  // own shadow — a hint of green, not a backdrop.
  put(bucket, 'pcb', boxAt(mm(16), mm(9), mm(0.9), bx(126), by(11.0), Z_PLATE_FACE + mm(1.9)))

  // ── SPEAKER LEVEL knob ───────────────────────────────────────────────────
  // Collar ring stays with the panel; the knob body is a named, rotatable child.
  put(bucket, 'dark', ringZ(mm(3.4), mm(5.6), bx(29.5), by(63), Z_PLATE_FACE - mm(0.05), 26))
  put(bucket, 'dark', tubeZ(mm(3.4), mm(3.4), mm(1.6), bx(29.5), by(63), Z_PLATE_FACE - mm(1.5), 26))
  const knobPivot = new THREE.Object3D()
  knobPivot.name = 'speaker-level-knob-pivot'
  knobPivot.position.set(bx(29.5), by(63), Z_PLATE_FACE - mm(1.5))

  // ── AUDIO / VIDEO MONOC RCA jacks ────────────────────────────────────────
  rcaJack(bucket, 54, 57, 'rcaWhite')
  rcaJack(bucket, 54, 70.5, 'rcaYellow')

  // ── DATA CORDER / RGB — 8-pin DIN 45326 ──────────────────────────────────
  dinSocket(bucket, 80, 66, 7.7, dinPins(8, 3.5, 300))
  dinSocket(bucket, 107, 66, 7.7, dinPins(8, 3.5, 300))
  for (const x of [80, 107]) {
    screw(bucket, 'chrome', x, 52.5, 1.9)
    // The two unpopulated mounting holes either side, as photographed.
    for (const dx of [-9, 9]) {
      put(bucket, 'deepDark', boreZ(mm(1.0), mm(2.0), bx(x + dx), by(52.5), Z_PLATE_FACE, 12))
      put(bucket, 'deepDark', discZ(mm(1.0), bx(x + dx), by(52.5), Z_PLATE_FACE + mm(2.0), 12))
    }
  }

  // ── GND brass thumb nut ──────────────────────────────────────────────────
  groundPost(bucket, 92, 31)

  // ── BUS EXPANSION ────────────────────────────────────────────────────────
  shroudedHeader(bucket, 161.5, 31, 90, 12.6, 25, 4.4)

  // ── KEYBOARD INPUT — 13-pin DIN 41524 ────────────────────────────────────
  dinSocket(bucket, 246, 25, 8.6, [
    ...dinRing(8, 4.5, Math.PI / 8),
    ...dinRing(4, 2.3, Math.PI / 4),
    { r: 0, a: 0 },
  ])
  // Reference shows a brass earth screw left of the socket and a plated steel
  // screw right of it; both are modelled as real pan-head Phillips fixings.
  screw(bucket, 'brass', 230, 25, 2.1)
  screw(bucket, 'chrome', 262, 25, 2.1)

  // ── PARALLEL PRINTER — 25-pin ribbon header ──────────────────────────────
  shroudedHeader(bucket, 295, 30, 50, 11.4, 13, 3.8)

  // ── FUSE holder — knurled bakelite cap ───────────────────────────────────
  put(bucket, 'dark', portCyl(4.4, 4, 330, 66, 22))
  put(bucket, 'dark', portFace(4.4, 4, 0.05, 330, 66, 22))
  put(bucket, 'deepDark', boxAt(mm(5.2), mm(1), mm(1), bx(330), by(66), Z_PLATE_FACE - mm(3.9)))

  // ── SWITCHED OUTLET — two mains sockets ──────────────────────────────────
  for (const x of [348, 367]) {
    put(bucket, 'dark', boxAt(mm(13), mm(27), mm(3.2), bx(x), by(65), Z_PLATE_FACE - mm(0.8)))
    for (const dy of [-6.5, 6.5]) {
      put(bucket, 'deepDark', boxAt(mm(2.6), mm(7.4), mm(0.6), bx(x), by(65 + dy), Z_PLATE_FACE - mm(2.5)))
      put(bucket, 'deepDark', portFace(2.0, 2.45, 0, x, 65 + dy - 3.4, 12))
    }
  }

  // ── AC INPUT — 120 V / 240 V slider ──────────────────────────────────────
  put(bucket, 'deepDark', boxAt(mm(10), mm(6), mm(1.2), bx(374), by(42.5), Z_PLATE_FACE - mm(0.3)))
  const slider = new THREE.Mesh(boxAt(mm(4.2), mm(4.4), mm(2.4), 0, 0, 0))
  slider.name = 'voltage-selector'
  slider.position.set(bx(374) + mm(2.2), by(42.5), Z_PLATE_FACE - mm(1.4))
  screw(bucket, 'chrome', 359, 42.5, 2.1)
  screw(bucket, 'chrome', 389, 42.5, 2.1)

  // ── Mains cord grommet ───────────────────────────────────────────────────
  put(bucket, 'dark', portCyl(5.4, 2.6, 386, 70, 22))
  put(bucket, 'dark', portFace(5.4, 2.6, 0.05, 386, 70, 22))

  // ── Chassis screws ───────────────────────────────────────────────────────
  // One reusable pan-head profile, instanced at every plate fixing point.
  for (const p of [
    { x: 4, y: 50 },
    { x: 4, y: 76 },
    { x: 390, y: 60 },
    { x: 390, y: 78 },
    { x: 197, y: 79 },
  ]) {
    screw(bucket, 'chrome', p.x, p.y, 2.4)
  }

  return { knobPivot, voltageSlider: slider }
}

// ---------------------------------------------------------------------------
// Front hardware
// ---------------------------------------------------------------------------

/**
 * A rounded slab facing the viewer: `w × h` in the XY plane, `depth` deep, with
 * its front face landing exactly on `zFront`. Buttons, covers and mouldings all
 * get a real edge radius this way rather than a razor-sharp box.
 */
function frontSlab(
  w: number,
  h: number,
  cornerR: number,
  depth: number,
  x: number,
  y: number,
  zFront: number,
  bevel = mm(0.35),
): THREE.BufferGeometry {
  const b = Math.min(bevel, depth / 2 - 1e-6, w / 4, h / 4)
  const shape = roundedRectShape(w - 2 * b, h - 2 * b, Math.max(cornerR - b, 1e-4), x, y)
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 4,
    steps: 1,
  })
  g.translate(0, 0, zFront - depth + b)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(44))
  return prep(g)
}

const FZ = Z_FASCIA_FRONT

/**
 * Floor of the recessed cartridge zone, sitting `RECESS.depth` behind the panel,
 * with a real opening for each bay. The 0.8 mm margin between the opening and
 * the dust cover is the parting gap — it is what carries the cover's own AO and
 * makes the flap read as a separate moulding rather than as printing.
 */
function recessFloorGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const pts: readonly (readonly [number, number])[] = [
    [fx(RECESS.xTop - 1), fy(RECESS.yTop - 1)],
    [fx(RECESS.xRight + 1), fy(RECESS.yTop - 1)],
    [fx(RECESS.xRight + 1), fy(RECESS.yBottom + 1)],
    [fx(RECESS.xBottom - 1), fy(RECESS.yBottom + 1)],
  ]
  const first = pts[0]
  if (first === undefined) return new THREE.BufferGeometry()
  shape.moveTo(first[0], first[1])
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]
    if (p !== undefined) shape.lineTo(p[0], p[1])
  }
  const coverMidY = COVER_TOP_MM + (COVER_H / mm(1)) / 2
  for (const x0 of [BAY_A_X_MM, BAY_B_X_MM]) {
    shape.holes.push(
      roundedRectPath(
        COVER_W + mm(1.6),
        COVER_H + mm(1.6),
        mm(1.4),
        fx(x0) + COVER_W / 2,
        fy(coverMidY),
      ),
    )
  }
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: mm(2),
    bevelEnabled: false,
    curveSegments: 4,
    steps: 1,
  })
  g.translate(0, 0, Z_FASCIA_FRONT - RECESS.depth - mm(2))
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(40))
  return prep(g)
}

/**
 * Dust-cover slab, built in the hinge pivot's local frame: origin on the hinge
 * line at the cover's top edge, +Z forward, the recess floor at z = 0.
 *
 * The aperture is a genuine hole through the slab, so the strip behind it is
 * geometrically recessed and picks up its own occlusion ramp at the top edge and
 * its own lip highlight at the bottom — the two cues the flat black rectangle it
 * replaces could never produce.
 */
function coverGeometry(): THREE.BufferGeometry {
  const shape = roundedRectShape(COVER_W, COVER_H, mm(1.2), 0, -COVER_H / 2)
  shape.holes.push(
    roundedRectPath(COVER_W * 0.7, COVER_H * 0.3, mm(0.5), 0, -COVER_H * 0.5),
  )
  const bevel = mm(0.5)
  const depth = mm(3.2)
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 5,
    steps: 1,
  })
  g.translate(0, 0, COVER_FACE_Z - depth)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-6)
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(42))
  return prep(g)
}

/**
 * Cartridge bay behind a dust cover: dark cavity plus a pair of guide rails.
 * `xLeft` is the bay's left edge, in millimetres from the left of the front face.
 */
function cartridgeBay(bucket: Bucket, xLeft: number): void {
  const cx = fx(xLeft) + COVER_W / 2
  const cy = fy(36.5)
  put(bucket, 'deepDark', boxAt(mm(102), mm(20), mm(46), cx, cy, FZ - mm(26)))
  for (const dy of [-8.5, 8.5]) {
    put(bucket, 'dark', boxAt(mm(96), mm(1.6), mm(40), cx, cy + mm(dy), FZ - mm(24)))
  }
  // Card-edge socket at the back of the bay.
  put(bucket, 'connectorBody', boxAt(mm(90), mm(6), mm(4), cx, cy, FZ - mm(47)))
}

/**
 * Ten pushbuttons — 2 rows × 5 columns of wide 4.5 × 2.5 mm caps on a 5.6 mm
 * pitch, 0.8 mm proud, each with a 0.3 mm top fillet.
 *
 * SPEC §2.1 says "6 small square buttons in a 2×3 grid"; the reference plainly
 * shows ten wide landscape rectangles with a micro-legend printed above each
 * row, so the photograph wins. Modelled as real bodies rather than painted, so
 * every cap gets its own highlight and its own contact shadow into the bezel.
 */
function buttonCluster(bucket: Bucket): THREE.Mesh[] {
  const bz = BUTTONS.bezel
  // Bezel floor, 0.9 mm behind the panel face.
  put(
    bucket,
    'dark',
    boxAt(
      mm(bz.x1 - bz.x0 + 1.6),
      mm(bz.y1 - bz.y0 + 1.6),
      mm(2),
      fx((bz.x0 + bz.x1) / 2),
      fy((bz.y0 + bz.y1) / 2),
      FZ - mm(0.9) - mm(1),
    ),
  )
  const meshes: THREE.Mesh[] = []
  for (let row = 0; row < BUTTONS.rowY.length; row++) {
    const rowY = BUTTONS.rowY[row]
    if (rowY === undefined) continue
    for (let col = 0; col < 5; col++) {
      const x = fx(BUTTONS.x0 + col * BUTTONS.pitch + BUTTONS.capW / 2)
      const y = fy(rowY)
      const geo = frontSlab(
        mm(BUTTONS.capW),
        mm(BUTTONS.capH),
        mm(0.35),
        mm(2.4),
        x,
        y,
        FZ - mm(0.9) + BUTTONS.proud,
        mm(0.3),
      )
      const mesh = new THREE.Mesh(geo)
      mesh.name = `function-button-${row * 5 + col + 1}`
      meshes.push(mesh)
    }
  }
  return meshes
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Where the console sits on the desk. Pushed back so the detached keyboard has
 * ~100 mm of clear desk in front of it; X-centred, bottom of the feet on y = 0.
 */
const UNIT_Z = mm(-75)

/** Named handles the interaction layer animates. All are children of the root group. */
export interface MainUnitHandles {
  readonly root: THREE.Group
  /** Hinge at the top edge of each dust cover. Rotate +X to push the flap in. */
  readonly slotACoverPivot: THREE.Object3D
  readonly slotBCoverPivot: THREE.Object3D
  readonly slotACover: THREE.Mesh
  readonly slotBCover: THREE.Mesh
  /** Empty at the mouth of each bay: where a cartridge starts its slide. */
  readonly slotAMouth: THREE.Object3D
  readonly slotBMouth: THREE.Object3D
  readonly powerSwitch: THREE.Mesh
  readonly powerIndicator: THREE.Mesh
  readonly speakerLevelKnob: THREE.Object3D
  readonly voltageSelector: THREE.Mesh
  /** Flap angle (rad) for the reset push, and for a fully opened bay. */
  readonly coverPushAngle: number
  readonly coverOpenAngle: number
  /** Travel (m) of the power switch when pressed. */
  readonly powerSwitchTravel: number
}

function tag(object: THREE.Object3D, data: InteractiveUserData): void {
  Object.assign(object.userData, data)
}

export class MainUnitModule implements SceneModule {
  readonly name = 'MainUnit'

  private root: THREE.Group | null = null
  private partHandles: MainUnitHandles | null = null
  private readonly ownedMaterials: THREE.Material[] = []
  private readonly ownedTextures: THREE.Texture[] = []
  /** Filled from the renderer in `build()`; the back decal needs the maximum. */
  private maxAnisotropy = 8

  /** Available after `build()`. */
  get handles(): MainUnitHandles | null {
    return this.partHandles
  }

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    const group = new THREE.Group()
    group.name = 'unidade-principal'
    group.position.z = UNIT_Z
    this.root = group
    this.maxAnisotropy = Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy())

    // ── Materials ─────────────────────────────────────────────────────────
    const lib = ctx.materials
    const derive = (
      base: THREE.MeshPhysicalMaterial,
      name: string,
      hex: number,
      roughness: number,
    ): THREE.MeshPhysicalMaterial => {
      const m = base.clone()
      m.name = name
      m.color.setHex(hex)
      m.roughness = roughness
      this.ownedMaterials.push(m)
      return m
    }

    /**
     * Painted steel finish for the back plate. Two things separate it from the
     * case mouldings: the grain must be an order of magnitude finer (a ~0.2 mm
     * paint speckle, not a 1.2 mm ABS pebble — at 6× tiling the plate read as
     * leather), and the specular has to break into a stipple rather than one
     * broad sheen. Both come from re-tiling the shared maps far denser.
     */
    const platePaint = (base: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial => {
      const m = base.clone()
      m.name = 'case-back-plate'
      m.color.setHex(PLATE_ALBEDO)
      m.roughness = 0.58
      for (const slot of ['normalMap', 'roughnessMap', 'aoMap'] as const) {
        const source = base[slot]
        if (source === null) continue
        const t = source.clone()
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.repeat.set(34, 34)
        t.needsUpdate = true
        this.ownedTextures.push(t)
        m[slot] = t
      }
      m.normalScale = new THREE.Vector2(0.3, 0.3)
      m.needsUpdate = true
      this.ownedMaterials.push(m)
      return m
    }

    /**
     * Re-tiles the shared case maps to {@link GRAIN_TILE}. The library calibrates
     * its `repeat` for 0..1 face UVs; this module projects planar UVs at
     * {@link UV_SCALE} metres, so the tiling has to be restated in those terms or
     * the grain lands ~10× too coarse and every panel reads as pebbled vinyl.
     *
     * Normal amplitude drops with the cell size: finer tooling grain is also
     * shallower, and at these camera distances a 0.18 mm cell is close to
     * sub-pixel, where a strong normal only buys specular aliasing.
     */
    const caseTile = (
      base: THREE.MeshPhysicalMaterial,
      name: string,
      hex: number | null,
      roughness: number | null,
      normalScale = 0.05,
      uvScale = UV_SCALE,
    ): THREE.MeshPhysicalMaterial => {
      const m = base.clone()
      m.name = name
      if (hex !== null) m.color.setHex(hex)
      if (roughness !== null) m.roughness = roughness
      const repeat = uvScale / GRAIN_TILE
      for (const slot of ['normalMap', 'roughnessMap', 'aoMap'] as const) {
        const source = base[slot]
        if (source === null) continue
        const t = source.clone()
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        // Slightly anisotropic tiling: an exactly square repeat lets the noise
        // lattice line up with itself tile to tile and read as a woven diagonal.
        t.repeat.set(repeat, repeat * 0.91)
        // A 0.18 mm cell is deep in minification territory on the big flat
        // planes; without maximum anisotropy the grain moirés at grazing angles.
        t.anisotropy = this.maxAnisotropy
        t.needsUpdate = true
        this.ownedTextures.push(t)
        m[slot] = t
      }
      m.normalScale = new THREE.Vector2(normalScale, normalScale)
      m.needsUpdate = true
      this.ownedMaterials.push(m)
      return m
    }

    const panel = lib.panelBlack()
    const panelTiled = caseTile(panel, 'panel-black-fine', null, null, 0.1)
    const materials: Record<string, THREE.Material> = {
      graphite: caseTile(lib.caseGraphite(), 'case-graphite-fine', null, null),
      fascia: caseTile(lib.caseFascia(), 'case-fascia-fine', null, 0.66, 0.11),
      plate: platePaint(lib.caseSilver()),
      dark: panelTiled,
      /**
       * Dust-cover plastic: a dark grey that is deliberately *lighter* than the
       * near-black insert panel, exactly as photographed (cover ≈ 57/255 against
       * a 50/255 fascia). Printing the MSX mark on it only works because it is
       * plastic, not a hole.
       */
      cover: caseTile(panel, 'slot-cover', 0x2a2826, 0.6, 0.11),
      /**
       * The POWER strip is a different, shinier plastic inset into the fascia —
       * roughness 0.20 against the panel's 0.66. That material break is most of
       * what makes the zone read as hardware rather than as printing.
       */
      gloss: caseTile(panel, 'power-strip-gloss', 0x191817, 0.2, 0.07),
      deepDark: derive(panel, 'cavity-black', 0x0b0c0d, 0.86),
      connectorBody: derive(panel, 'connector-body', 0xa9a496, 0.55),
      dinBody: derive(panel, 'din-body', 0x141416, 0.62),
      dinShell: lib.metal(0xb4b8ba, 0.46),
      dinInsert: derive(panel, 'din-insert', 0x232427, 0.72),
      // Reference: the ten pushbuttons are a *light* grey, roughly twice the
      // fascia's luminance — not dark tiles that vanish into the panel.
      buttonCap: caseTile(panel, 'button-cap', 0x8a877f, 0.5, 0.1),
      /**
       * RCA insulators. Aged ivory and chrome-yellow — never lemon, but the r4
       * values were so far down that the panel's grazing key rendered the yellow
       * as olive (#9c9449, R−B = 79) and the ivory as blue-grey. Insulator
       * mouldings are *saturated* pigment in bulk PVC: the albedo carries the
       * hue, the dim light cannot invent it back.
       */
      rcaWhite: derive(panel, 'rca-white', 0xe4dcc6, 0.5),
      rcaYellow: derive(panel, 'rca-yellow', 0xdeb41e, 0.5),
      pcb: derive(panel, 'pcb-edge', 0x1e4a2e, 0.62),
      /** Mains-side loom: pale grey-ivory PVC, the bright mass in the reference. */
      loomPale: derive(panel, 'loom-pale', 0xbdb7a8, 0.78),
      /** Varnished transformer bobbin — the warm amber seen through the lower row. */
      transformer: derive(panel, 'transformer', 0x8a5a22, 0.7),
      wireRed: derive(panel, 'wire-red', 0xa8281d, 0.66),
      wireGreen: derive(panel, 'wire-green', 0x1f6b3a, 0.66),
      wireYellow: derive(panel, 'wire-yellow', 0xcfa724, 0.66),
      chrome: lib.metal(PALETTE.chrome, 0.32),
      /**
       * Plated chassis screw. Metalness is pulled off 1.0 on purpose: a pure
       * conductor shows only what it can see, and what a rear panel lit at a graze
       * can see is the void — which is why every screw head measured as a dark
       * speck against a 90-level plate while the reference photograph shows the
       * heads *brighter* than the paint around them. Zinc plating over steel
       * scatters a broad near-diffuse lobe on top of its specular; mixed metalness
       * is the cheapest honest model of that, and it lands the heads on the right
       * side of the plate's value instead of inverting the relationship.
       */
      screwSteel: ((): THREE.MeshPhysicalMaterial => {
        const m = derive(lib.metal(PALETTE.chrome, 0.44), 'screw-plated-steel', 0xd9d6cc, 0.44)
        m.metalness = 0.72
        m.envMapIntensity = 1.5
        return m
      })(),
      shellMetal: lib.metal(PALETTE.connectorShell, 0.42),
      brass: lib.metal(PALETTE.brass, 0.3),
      gold: lib.metal(0xc9a227, 0.28),
      rubber: lib.rubber(),
    }

    // ── Static geometry, bucketed by material ─────────────────────────────
    const bucket: Bucket = new Map()
    put(bucket, 'graphite', shellGeometry())
    put(bucket, 'graphite', chassisGeometry())
    put(bucket, 'graphite', frontRailGeometry())
    put(bucket, 'graphite', rearFrameGeometry())
    put(bucket, 'fascia', fasciaGeometry())
    put(bucket, 'fascia', recessFloorGeometry())
    put(bucket, 'plate', backPlateGeometry())
    // Glossy floor of the POWER strip recess.
    put(
      bucket,
      'gloss',
      boxAt(
        mm(POWER_STRIP.x1 - POWER_STRIP.x0 + 1.4),
        mm(POWER_STRIP.y1 - POWER_STRIP.y0 + 1.4),
        mm(2),
        fx((POWER_STRIP.x0 + POWER_STRIP.x1) / 2),
        fy((POWER_STRIP.y0 + POWER_STRIP.y1) / 2),
        Z_FASCIA_FRONT - POWER_STRIP.depth - mm(1),
      ),
    )

    const feet = feetGeometry()
    if (feet !== null) put(bucket, 'rubber', feet)

    const back = buildBackHardware(bucket)
    cartridgeBay(bucket, BAY_A_X_MM)
    cartridgeBay(bucket, BAY_B_X_MM)
    for (const capMesh of buttonCluster(bucket)) put(bucket, 'buttonCap', capMesh.geometry)

    // O merge dos buckets é o trecho de geometria mais caro do módulo: fatia própria.
    await yieldToMain()
    for (const [key, parts] of bucket) {
      const merged = mergeAll(parts)
      const material = materials[key]
      if (merged === null || material === undefined) continue
      const mesh = new THREE.Mesh(merged, material)
      mesh.name = `unidade-${key}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }

    // ── Interactive hardware ──────────────────────────────────────────────
    back.knobPivot.add(this.buildSpeakerKnob(materials))
    tag(back.knobPivot, {
      partId: 'speaker-level-knob',
      label: 'Volume do alto-falante',
      cursor: 'grab',
    })
    group.add(back.knobPivot)

    back.voltageSlider.material = materials['chrome'] ?? materials['dark'] ?? new THREE.MeshBasicMaterial()
    back.voltageSlider.castShadow = true
    tag(back.voltageSlider, {
      partId: 'voltage-selector',
      label: 'Seletor de tensão — 120 V / 240 V',
      cursor: 'ew-resize',
    })
    group.add(back.voltageSlider)

    /**
     * The reference front panel carries **no rocker and no orange LED** — just a
     * long glossy black recessed strip with POWER pad-printed on it. The strip
     * itself is therefore the switch: it is a real body that travels inward when
     * pressed, keeping SPEC §8's interaction without inventing hardware the
     * machine does not have.
     */
    const powerSwitch = new THREE.Mesh(
      frontSlab(
        mm(POWER_STRIP.x1 - POWER_STRIP.x0 - 0.6),
        mm(POWER_STRIP.y1 - POWER_STRIP.y0 - 0.6),
        mm(0.7),
        mm(1.2),
        fx((POWER_STRIP.x0 + POWER_STRIP.x1) / 2),
        fy((POWER_STRIP.y0 + POWER_STRIP.y1) / 2),
        Z_FASCIA_FRONT - POWER_STRIP.depth,
        mm(0.25),
      ),
      materials['gloss'] ?? materials['dark'] ?? new THREE.MeshBasicMaterial(),
    )
    powerSwitch.name = 'power-switch'
    powerSwitch.castShadow = true
    powerSwitch.receiveShadow = true
    tag(powerSwitch, { partId: 'power-switch', label: 'Liga / desliga', cursor: 'pointer' })
    group.add(powerSwitch)

    // A pin-head lens at the right end of the strip. Nearly invisible when off —
    // the reference shows no glowing indicator at all on the front panel.
    const lens = new THREE.MeshPhysicalMaterial({
      name: 'power-lens',
      color: new THREE.Color(0x2a0d0a),
      emissive: new THREE.Color(0xff5a2a),
      emissiveIntensity: 0,
      roughness: 0.16,
      metalness: 0,
      ior: 1.55,
      dithering: true,
    })
    this.ownedMaterials.push(lens)
    const indicator = new THREE.Mesh(
      frontSlab(
        mm(1.8),
        mm(1.4),
        mm(0.4),
        mm(1),
        fx(POWER_STRIP.x1 - 5),
        fy(POWER_STRIP.y0 + 4.6),
        Z_FASCIA_FRONT - POWER_STRIP.depth + mm(0.15),
        mm(0.2),
      ),
      lens,
    )
    indicator.name = 'power-indicator'
    group.add(indicator)

    // ── Cartridge bays ────────────────────────────────────────────────────
    const bayA = this.buildCoverAssembly(materials, BAY_A_X_MM, 'A')
    const bayB = this.buildCoverAssembly(materials, BAY_B_X_MM, 'B')
    group.add(bayA.pivot, bayA.mouth, bayB.pivot, bayB.mouth)

    // ── Decal layers ──────────────────────────────────────────────────────
    await this.addDecals(group, bayA.pivot, bayB.pivot)

    // ── Cord, the peeling sticker corner, and the contact shadow ──────────
    group.add(this.buildCord(materials))
    group.add(this.buildStickerPeel())
    group.add(this.buildContactShadow())

    this.partHandles = {
      root: group,
      slotACoverPivot: bayA.pivot,
      slotBCoverPivot: bayB.pivot,
      slotACover: bayA.cover,
      slotBCover: bayB.cover,
      slotAMouth: bayA.mouth,
      slotBMouth: bayB.mouth,
      powerSwitch,
      powerIndicator: indicator,
      speakerLevelKnob: back.knobPivot,
      voltageSelector: back.voltageSlider,
      coverPushAngle: 0.20,
      coverOpenAngle: 1.05,
      powerSwitchTravel: mm(1.1),
    }
    return group
  }

  /**
   * Splined volume knob, built at the origin so the pivot can spin it.
   *
   * The splines are real geometry, not a normal map: at this camera the knob's
   * *silhouette* is what sells it, and a normal map leaves a smooth cone edge.
   * A chamfered mounting collar and a milled pointer indent complete the read.
   */
  private buildSpeakerKnob(materials: Record<string, THREE.Material>): THREE.Object3D {
    const group = new THREE.Object3D()
    group.name = 'speaker-level-knob'

    const parts: THREE.BufferGeometry[] = []
    // Chamfered collar at the panel, then the barrel.
    // After `rotateX(+90°)` the cylinder's *first* radius ends up at +Z, i.e.
    // against the panel. The knob therefore tapers 5.2 → 4.7 → 3.5 outward.
    const collar = new THREE.CylinderGeometry(mm(5.2), mm(4.7), mm(1.2), 32, 1, false)
    collar.rotateX(Math.PI / 2)
    collar.translate(0, 0, -mm(0.6))
    parts.push(prep(collar, 0.05))
    const body = new THREE.CylinderGeometry(mm(4.7), mm(4.3), mm(5.4), 32, 1, false)
    body.rotateX(Math.PI / 2)
    body.translate(0, 0, -mm(3.9))
    parts.push(prep(body, 0.05))
    // 20 vertical splines standing 0.7 mm off the barrel — the silhouette teeth.
    for (let i = 0; i < 20; i++) {
      const rib = new THREE.BoxGeometry(mm(0.85), mm(1.5), mm(4.6))
      rib.translate(0, mm(4.6), -mm(3.9))
      rib.rotateZ((i / 20) * Math.PI * 2)
      parts.push(prep(rib, 0.05))
    }
    // Flat top with a rounded edge break.
    const top = new THREE.CylinderGeometry(mm(4.3), mm(3.5), mm(0.8), 32, 1, false)
    top.rotateX(Math.PI / 2)
    top.translate(0, 0, -mm(7.0))
    parts.push(prep(top, 0.05))
    const cap = new THREE.CircleGeometry(mm(3.5), 32)
    cap.rotateY(Math.PI)
    cap.translate(0, 0, -mm(7.4))
    parts.push(prep(cap, 0.05))

    const body_ = new THREE.Mesh(
      mergeAll(parts) ?? new THREE.BufferGeometry(),
      materials['dark'] ?? new THREE.MeshBasicMaterial(),
    )
    body_.name = 'speaker-level-knob-body'
    body_.castShadow = true
    group.add(body_)

    // Milled pointer indent: a dark groove across the face, so the setting reads.
    const indent = new THREE.Mesh(
      boxAt(mm(0.9), mm(3.0), mm(0.6), 0, mm(1.5), -mm(7.5)),
      materials['deepDark'] ?? new THREE.MeshBasicMaterial(),
    )
    indent.name = 'speaker-level-knob-pointer'
    group.add(indent)
    return group
  }

  /** One cartridge bay: hinge, flap, and the empty a cartridge slides along. */
  private buildCoverAssembly(
    materials: Record<string, THREE.Material>,
    xLeft: number,
    letter: 'A' | 'B',
  ): { pivot: THREE.Object3D; cover: THREE.Mesh; mouth: THREE.Object3D } {
    const slot = letter.toLowerCase()
    const pivot = new THREE.Object3D()
    pivot.name = `slot-${slot}-pivot`
    // Hinge line: the cover's top edge, inside the recess.
    const coverCx = fx(xLeft) + COVER_W / 2
    pivot.position.set(coverCx, fy(COVER_TOP_MM), Z_FASCIA_FRONT - RECESS.depth)

    /**
     * The dust cover is a **real body**, not a painted rectangle: a 3.2 mm slab
     * filling the bay, carrying the same shell grain, with a 0.8 mm parting gap
     * on all four sides (COVER_W/H are already the reduced-by-gap dimensions) and
     * a 0.5 mm fillet on its lip. Without it, SPEC §8's push-to-reset has nothing
     * to push, and the MSX print is left floating inside a hole.
     */
    const cover = new THREE.Mesh(
      coverGeometry(),
      materials['cover'] ?? new THREE.MeshBasicMaterial(),
    )
    cover.name = `slot-${slot}-cover`
    cover.castShadow = true
    cover.receiveShadow = true
    tag(cover, {
      partId: letter === 'A' ? 'slot-a-cover' : 'slot-b-cover',
      label: `Slot de cartucho ${letter} — empurre para reiniciar`,
      cursor: 'pointer',
    })
    pivot.add(cover)

    /**
     * The aperture: a thin strip recessed *into* the cover, ~1/3 its height and
     * ~70 % of its width — that is the geometry the reference shows, and it is
     * what the MSX mark is centred on.
     */
    const aperture = new THREE.Mesh(
      boxAt(
        COVER_W * 0.74,
        COVER_H * 0.34,
        mm(1.4),
        0,
        -COVER_H * 0.5,
        COVER_FACE_Z - mm(1.9),
      ),
      materials['deepDark'] ?? new THREE.MeshBasicMaterial(),
    )
    aperture.name = `slot-${slot}-recess`
    aperture.receiveShadow = true
    pivot.add(aperture)

    const mouth = new THREE.Object3D()
    mouth.name = `slot-${slot}-mouth`
    mouth.position.set(coverCx, fy(36.5), Z_FASCIA_FRONT - RECESS.depth - mm(4))
    return { pivot, cover, mouth }
  }

  /**
   * Contact shadow under the chassis.
   *
   * The console stands on four 6 mm feet, so light *does* get underneath — but a
   * RectAreaLight key cannot be occluded in three.js, which left the darkest
   * point under the machine at only ~1.5:1 against open desk and made the box
   * look welded to the table. This is the missing occlusion, authored as a
   * multiply layer: a near-black core over the chassis footprint decaying over
   * ~35 mm, i.e. the penumbra a 6 mm gap actually produces.
   */
  private buildContactShadow(): THREE.Mesh {
    const px = 256
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    const c2d = canvas.getContext('2d')
    const w = BODY_W + mm(90)
    const d = BODY_D + mm(90)
    // A black quad whose *alpha* carries the occlusion. Multiply blending would be
    // the textbook choice but three.js requires premultiplied alpha for it, and a
    // straight translucent black lays down the same falloff with none of that.
    const material = new THREE.MeshBasicMaterial({
      name: 'sombra-de-contato',
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    if (c2d !== null) {
      c2d.clearRect(0, 0, px, px)
      // Footprint in canvas pixels, then a blurred inset core.
      const fx0 = ((w / 2 - BODY_W / 2) / w) * px
      const fy0 = ((d / 2 - BODY_D / 2) / d) * px
      const fw = (BODY_W / w) * px
      const fh = (BODY_D / d) * px
      c2d.filter = 'blur(13px)'
      c2d.fillStyle = 'rgba(0,0,0,0.62)'
      c2d.fillRect(fx0 + 2, fy0 + 2, fw - 4, fh - 4)
      c2d.filter = 'blur(4px)'
      c2d.fillStyle = 'rgba(0,0,0,0.55)'
      c2d.fillRect(fx0 + 6, fy0 + 6, fw - 12, fh - 12)
      c2d.filter = 'none'
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      texture.anisotropy = this.maxAnisotropy
      texture.needsUpdate = true
      this.ownedTextures.push(texture)
      material.alphaMap = texture
      material.needsUpdate = true
    }
    this.ownedMaterials.push(material)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material)
    mesh.name = 'sombra-de-contato'
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(0, mm(0.4), 0)
    mesh.renderOrder = 1
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  /** Moulded mains cord, leaving the grommet and sagging onto the desk. */
  private buildCord(materials: Record<string, THREE.Material>): THREE.Mesh {
    const start = new THREE.Vector3(bx(386), by(70), Z_PLATE_FACE - mm(3))
    const deskTouch = new THREE.Vector3(start.x - mm(78), mm(4), start.z - mm(52))
    const hanging = catenary(start, deskTouch, 0.02, 32)
    const curve = new THREE.CatmullRomCurve3([
      ...hanging,
      new THREE.Vector3(start.x - mm(150), mm(3.5), start.z - mm(66)),
      new THREE.Vector3(start.x - mm(235), mm(3.5), start.z - mm(58)),
    ], false, 'centripetal')
    const geo = new THREE.TubeGeometry(curve, 48, mm(2.3), 10, false)
    const mesh = new THREE.Mesh(prep(geo, 0.08), materials['rubber'] ?? new THREE.MeshBasicMaterial())
    mesh.name = 'cabo-ac'
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  /**
   * The service sticker's lifted corner. Modelled rather than painted, because
   * the tiny shadow it throws is what makes the sticker read as a physical label.
   */
  private buildStickerPeel(): THREE.Mesh {
    const material = new THREE.MeshPhysicalMaterial({
      name: 'sticker-peel',
      color: new THREE.Color(0xc9a55e),
      // Aged paper, not a lacquered swatch: it must stop mirroring the floor.
      roughness: 0.72,
      metalness: 0,
      side: THREE.DoubleSide,
      dithering: true,
    })
    this.ownedMaterials.push(material)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mm(5.5), mm(6), 2, 2), material)
    mesh.name = 'adesivo-descolando'
    mesh.rotation.set(0, Math.PI - 0.34, 0.05)
    mesh.position.set(bx(171.4), by(77.6), Z_PLATE_FACE - mm(0.75))
    mesh.castShadow = true
    return mesh
  }

  /** Builds and places every silkscreen / label layer. */
  private async addDecals(
    group: THREE.Group,
    pivotA: THREE.Object3D,
    pivotB: THREE.Object3D,
  ): Promise<void> {
    const layers: Array<{ layer: DecalLayer; parent: THREE.Object3D }> = []

    // Every legend is parked on the exact plane it is printed on. The front has
    // four different depths (panel / bezel / POWER strip / cartridge recess) and
    // a single decal plane would leave millimetres of parallax on the macro poses.
    const panelW = PANEL_OPENING.x1 - PANEL_OPENING.x0
    const panelH = PANEL_OPENING.yHi - PANEL_OPENING.yLo
    const fasciaBand = await makeDecal({
      name: 'fascia',
      width: panelW,
      height: panelH,
      px: FASCIA_DECAL_PX,
      draw: drawFasciaPanel,
      substrateRoughness: 0.66,
      relief: 2.4,
    })
    fasciaBand.mesh.position.set(
      -BODY_W / 2 + (PANEL_OPENING.x0 + PANEL_OPENING.x1) / 2,
      (PANEL_OPENING.yLo + PANEL_OPENING.yHi) / 2,
      Z_FASCIA_FRONT + mm(0.12),
    )
    layers.push({ layer: fasciaBand, parent: group })

    const powerStrip = await makeDecal({
      name: 'power-strip',
      width: mm(POWER_STRIP.x1 - POWER_STRIP.x0),
      height: mm(POWER_STRIP.y1 - POWER_STRIP.y0),
      px: POWER_DECAL_PX,
      draw: drawPowerStrip,
      substrateRoughness: 0.2,
      relief: 1.8,
      normalScale: 0.6,
    })
    powerStrip.mesh.position.set(
      fx((POWER_STRIP.x0 + POWER_STRIP.x1) / 2),
      fy((POWER_STRIP.y0 + POWER_STRIP.y1) / 2),
      Z_FASCIA_FRONT - POWER_STRIP.depth + mm(0.12),
    )
    layers.push({ layer: powerStrip, parent: group })

    const bezel = await makeDecal({
      name: 'button-bezel',
      width: mm(BUTTONS.bezel.x1 - BUTTONS.bezel.x0),
      height: mm(BUTTONS.bezel.y1 - BUTTONS.bezel.y0),
      px: BEZEL_DECAL_PX,
      draw: drawButtonBezel,
      substrateRoughness: 0.74,
      relief: 1.4,
      normalScale: 0.5,
      wear: 0.24,
      seed: 0x2ad901,
    })
    bezel.mesh.position.set(
      fx((BUTTONS.bezel.x0 + BUTTONS.bezel.x1) / 2),
      fy((BUTTONS.bezel.y0 + BUTTONS.bezel.y1) / 2),
      Z_FASCIA_FRONT - mm(0.9) + mm(0.1),
    )
    layers.push({ layer: bezel, parent: group })

    const recess = await makeDecal({
      name: 'cartridge-recess',
      width: mm(RECESS.xRight - RECESS.xTop),
      height: mm(RECESS.yBottom - RECESS.yTop),
      px: RECESS_DECAL_PX,
      draw: drawRecess,
      substrateRoughness: 0.68,
      relief: 2.0,
      seed: 0x51ab73,
    })
    recess.mesh.position.set(
      fx((RECESS.xTop + RECESS.xRight) / 2),
      fy((RECESS.yTop + RECESS.yBottom) / 2),
      Z_FASCIA_FRONT - RECESS.depth + mm(0.12),
    )
    layers.push({ layer: recess, parent: group })

    for (const bay of [
      { pivot: pivotA, letter: 'A' as const },
      { pivot: pivotB, letter: 'B' as const },
    ]) {
      const cover = await makeDecal({
        name: `cover-${bay.letter.toLowerCase()}`,
        width: COVER_W,
        height: COVER_H,
        px: COVER_DECAL_PX,
        draw: drawCoverFace,
        substrateRoughness: 0.6,
        relief: 2.6,
        // The MSX mark's legibility must come from the raised ink's specular at
        // grazing angles, so the relief is pushed and the albedo held down.
        normalScale: 1.1,
        seed: 0x51ab00 + bay.letter.charCodeAt(0),
      })
      cover.mesh.position.set(0, -COVER_H / 2, COVER_FACE_Z + mm(0.1))
      layers.push({ layer: cover, parent: bay.pivot })
    }

    const back = await makeDecal({
      name: 'back-panel',
      width: PLATE_W,
      height: PLATE_H,
      px: BACK_DECAL_PX,
      draw: drawBackPanel,
      substrateRoughness: 0.6,
      // Silkscreen is *printed*, not moulded. The r1 pass ran relief 2.8 at
      // normalScale 0.95, and the emboss shadow it produced (p05 145 against a
      // plate median of 163) cancelled the ink's own brightness gain, so every
      // legend read as debossed plate. Flat ink, faint relief.
      relief: 1.0,
      normalScale: 0.45,
      // Heavy plate-wear erosion was eating the thin strokes before the mip
      // chain ever got to them. The ink is worn, not half-gone.
      wear: 0.07,
      ink: INK_BACK,
      anisotropy: this.maxAnisotropy,
      seed: 0x77c3d1,
    })
    back.mesh.rotation.y = Math.PI
    back.mesh.position.set(0, Y_PLATE_TOP - PLATE_H / 2, Z_PLATE_FACE - mm(0.15))
    layers.push({ layer: back, parent: group })

    // Top surface: no type, only 41 years of dust and wiping marks.
    const riseAngle = Math.atan2(REAR_RISE, BODY_D)
    const top = await makeDecal({
      name: 'top-wear',
      width: BODY_W,
      height: BODY_D / Math.cos(riseAngle),
      px: TOP_DECAL_PX,
      draw: drawTopWear,
      substrateRoughness: 0.72,
      relief: 1.1,
      normalScale: 0.5,
      wear: 0.05,
      seed: 0x9f14c2,
    })
    top.mesh.rotation.x = -Math.PI / 2 + riseAngle
    top.mesh.position.set(0, Y_SHELL_TOP_NOMINAL + mm(0.15), 0)
    layers.push({ layer: top, parent: group })

    for (const entry of layers) {
      entry.parent.add(entry.layer.mesh)
      this.ownedMaterials.push(entry.layer.material)
      this.ownedTextures.push(
        entry.layer.maps.map,
        entry.layer.maps.normalMap,
        entry.layer.maps.roughnessMap,
      )
    }
  }

  /**
   * Drives the front indicator from the machine's power state. `warmth` is the
   * CRT warm-up ramp (SPEC §8) — the lamp follows it so nothing snaps on.
   */
  setPower(state: { readonly on: boolean; readonly warmth: number }): void {
    const indicator = this.partHandles?.powerIndicator
    if (indicator === undefined) return
    const material = indicator.material
    if (!(material instanceof THREE.MeshPhysicalMaterial)) return
    const level = state.on ? 0.25 + 0.75 * Math.min(1, Math.max(0, state.warmth)) : 0
    material.emissiveIntensity = level * 2.6
  }

  dispose(): void {
    this.root?.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose()
    })
    for (const material of this.ownedMaterials) material.dispose()
    for (const texture of this.ownedTextures) texture.dispose()
    this.ownedMaterials.length = 0
    this.ownedTextures.length = 0
    this.partHandles = null
    this.root = null
  }
}

export function createMainUnit(): MainUnitModule {
  return new MainUnitModule()
}

/** Ready-made instance — `main.ts` picks this up by name. */
export const MainUnit: MainUnitModule = createMainUnit()

export default MainUnit
