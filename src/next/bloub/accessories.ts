/**
 * Accessories an owner puts on an agent's bloub, any number at once
 * (sections/agents/LookStudio.tsx). They are drawn outside the vendored
 * engine (view.ts), from what the engine gives each frame:
 *
 * - Cat ears sit on the engine's own body outline, the 64 points it projects
 *   for every sample. Each ear is pinned at a fixed angle of the profile, so
 *   it breathes, squashes, leans and spins with the body; it is sized by the
 *   body, so a body that collapses to a dot (thinking, sleep, burst, comet)
 *   takes its ears in with it. The ears follow the face: up when surprised,
 *   flat when angry, drooping when sad, one down when confused. Now and then
 *   one flicks.
 * - Whiskers hang off the face, beside and below the eyes, and fade with them.
 *
 * Per frame only an ear's transform and the whiskers' path change.
 */
import type { BotEngine, BotFrame } from './engine/engine'
import type { ExpressionId } from './engine/expressions'
import { TAU, clamp, createRng, easings, lerp, r2 } from './engine/math'
import { PROFILE_SAMPLES } from './engine/profiles'
import type { Point } from './engine/shape'
import type { StateId } from './engine/states'

export const ACCESSORIES = ['ears', 'whiskers'] as const

/** Whether a look wears ears, which need a taller box (view.ts VIEW_BOX_EARS). */
export const wearsEars = (accessories: readonly string[]) => accessories.includes('ears')

/** The outline of the frame the engine last sampled: its private `pts`, kept
 *  on the instance and rewritten by every sample. tests/bloub-accessories.test.ts
 *  fails if an engine update renames it or stops keeping it there. */
export const outlineOf = (engine: BotEngine): readonly Point[] => (engine as unknown as { pts: Point[] }).pts

/** The right ear in its own frame: x along the body's surface (+x is the
 *  outer side), the tip at y = -1, the base sunk to +0.45 so it overlaps the
 *  body whatever the ear does. The left ear is the same path mirrored. */
export const EAR_D = 'M-0.5 0.45C-0.5 -0.1 -0.17 -0.74 -0.03 -0.93Q0.07 -1.07 0.17 -0.93C0.33 -0.66 0.5 -0.15 0.5 0.45Z'

/** The engine's morph time for a new face (BotEngine.SHAPE_MORPH, which is
 *  loaded late with the engine): ears and eyes change together. The test
 *  checks the two stay equal. */
export const FACE_MORPH = 0.45

const DEG = Math.PI / 180
/** Profile indexes of the top and the bottom: the profile starts at 3 o'clock
 *  and runs clockwise on screen. */
const TOP = (PROFILE_SAMPLES * 3) / 4
const BOTTOM = PROFILE_SAMPLES / 4
/** An ear's base width and height in engine units (the ball at rest has radius 100). */
const EAR_W = 56
const EAR_H = 52
/** How far either side of the top the ears sit. A triangle's apex would stand
 *  up between ears placed that wide, so its ears hug the apex and it reads as a crown. */
const spreadOf = (shape: string) => (shape === 'triangle' ? 24 : 37) * DEG
/** How much an ear stands up along the body's axis instead of out along the surface. */
const UPRIGHT = 0.55
const WHISKER_LENGTH = 48

/** How an ear sits: splay in degrees (+ is outward and back, the way a cat
 *  flattens its ears) and height (1 at rest). */
interface EarPose { splay: number; h: number }
const both = (splay: number, h: number): [EarPose, EarPose] => [{ splay, h }, { splay, h }]
const EAR_POSES: Record<ExpressionId, [EarPose, EarPose]> = {
  neutre: both(8, 1),
  attentif: both(0, 1.08),
  surpris: both(-6, 1.18),
  excite: both(-2, 1.12),
  heureux: both(6, 1.02),
  hilare: both(12, 0.98),
  colere: both(50, 0.82),
  triste: both(64, 0.8),
  effraye: both(72, 0.7),
  mefiant: both(28, 0.92),
  confus: [{ splay: 2, h: 1.1 }, { splay: 42, h: 0.86 }],
  curieux: [{ splay: 0, h: 1.12 }, { splay: 16, h: 1 }],
  fier: both(2, 1.1),
  timide: both(46, 0.84),
  blase: both(20, 0.94),
  somnolent: both(40, 0.86),
}

/** Every state whose face the engine draws itself (`baseFace: false` in
 *  engine/states.ts) and the face the ears wear there instead of the agent's.
 *  The test fails when the engine's list changes. */
export const STATE_FACES: Partial<Record<StateId, ExpressionId>> = {
  notify: 'attentif',
  wink: 'heureux',
  sleep: 'somnolent',
  wide: 'surpris',
  alert: 'surpris',
  exclaim: 'surpris',
  thinking: 'neutre',
  egg: 'neutre',
  hexagon: 'neutre',
  play: 'neutre',
  orbit: 'neutre',
  burst: 'neutre',
  comet: 'neutre',
}
/** The face the ears wear in `state` for the agent's own `face`. */
export const earFace = (state: StateId, face: ExpressionId): ExpressionId => STATE_FACES[state] ?? face

const easeOutQuint = (k: number) => easings.easeOutQuint(clamp(k))

function at(pts: readonly Point[], k: number): Point {
  const n = pts.length
  const i = Math.floor(k)
  const a = pts[((i % n) + n) % n]!
  const b = pts[(((i + 1) % n) + n) % n]!
  return { x: lerp(a.x, b.x, k - i), y: lerp(a.y, b.y, k - i) }
}

function unit(x: number, y: number): Point {
  const length = Math.hypot(x, y) || 1
  return { x: x / length, y: y / length }
}

/** One ear flicks twice now and then, like a cat hearing something: degrees
 *  of splay for the [left, right] ear at time t. Each period draws from its
 *  own repeatable sequence, so a frame read again shows the same ears. */
function flick(t: number, seed: number): [number, number] {
  const PERIOD = 4.7
  const n = Math.floor(t / PERIOD)
  const rand = createRng(n * 7919 + seed)
  if (rand() < 0.3) return [0, 0]
  const dt = t - (n * PERIOD + 0.6 + rand() * (PERIOD - 1.6))
  if (dt < 0 || dt > 0.45) return [0, 0]
  const k = dt < 0.2 ? Math.sin((Math.PI * dt) / 0.2) : dt > 0.24 && dt < 0.42 ? 0.55 * Math.sin((Math.PI * (dt - 0.24)) / 0.18) : 0
  return rand() < 0.5 ? [28 * k, 0] : [0, 28 * k]
}

export interface AccessoryFrame {
  /** Transforms of the left and right ear: null without ears, or while the body is too small to wear them. */
  ears: [string | null, string | null]
  /** Every whisker as one path ('' without whiskers), and their opacity. */
  whiskers: string
  whiskerAlpha: number
}

/** One agent's accessories: keeps the face the ears follow, which morphs with
 *  the engine's own curve and duration. */
export class AccessoryRig {
  private readonly seed: number
  private from: [EarPose, EarPose]
  private to: [EarPose, EarPose]
  private since = Number.NEGATIVE_INFINITY

  /** `seed` keeps each agent's flicks to its own moments. */
  constructor(seed: number, face: ExpressionId) {
    this.seed = seed
    this.from = this.to = EAR_POSES[face] ?? EAR_POSES.neutre
  }

  setFace(face: ExpressionId, now: number): void {
    const next = EAR_POSES[face] ?? EAR_POSES.neutre
    if (next === this.to) return
    this.from = this.poseAt(now)
    this.to = next
    this.since = now
  }

  private poseAt(now: number): [EarPose, EarPose] {
    const k = easeOutQuint((now - this.since) / FACE_MORPH)
    if (k >= 1) return this.to
    const pose = (i: 0 | 1): EarPose => ({ splay: lerp(this.from[i].splay, this.to[i].splay, k), h: lerp(this.from[i].h, this.to[i].h, k) })
    return [pose(0), pose(1)]
  }

  /** `outline` is the engine's outline for `frame` (outlineOf). `motion`
   *  false (reduced motion) keeps the ears from flicking. Null for a look
   *  that wears nothing, which then costs nothing. */
  update(
    frame: BotFrame,
    outline: readonly Point[],
    now: number,
    look: { shape: string; accessories: readonly string[] },
    motion: boolean,
  ): AccessoryFrame | null {
    if (look.accessories.length === 0) return null
    const n = outline.length
    let cx = 0
    let cy = 0
    for (const p of outline) {
      cx += p.x
      cy += p.y
    }
    cx /= n
    cy /= n
    let radius = 0
    for (const p of outline) radius += Math.hypot(p.x - cx, p.y - cy)
    // Full size from 80% of the resting body, nothing below 30%.
    const size = easeOutQuint((radius / n / 100 - 0.3) / 0.5)

    const ears: [string | null, string | null] = [null, null]
    if (wearsEars(look.accessories) && size > 0.01) {
      const pose = this.poseAt(now)
      const flicks = motion ? flick(now, this.seed) : [0, 0]
      const spread = spreadOf(look.shape)
      // The body's own up, from the bottom of the profile to its top, so it
      // turns with a body that a state spins.
      const up = unit(outline[TOP]!.x - outline[BOTTOM]!.x, outline[TOP]!.y - outline[BOTTOM]!.y)
      for (const [i, side] of [[0, -1], [1, 1]] as const) {
        const k = (((-Math.PI / 2 + side * spread + TAU) % TAU) / TAU) * n
        const p = at(outline, k)
        const before = at(outline, k - 1)
        const after = at(outline, k + 1)
        const t = unit(after.x - before.x, after.y - before.y)
        // Clockwise on screen, so (t.y, -t.x) points out of the body.
        const d0 = unit(lerp(t.y, up.x, UPRIGHT), lerp(-t.x, up.y, UPRIGHT))
        const turn = side * (pose[i].splay + flicks[i]) * DEG
        const dx = d0.x * Math.cos(turn) - d0.y * Math.sin(turn)
        const dy = d0.x * Math.sin(turn) + d0.y * Math.cos(turn)
        const w = EAR_W * size
        const h = EAR_H * size * pose[i].h
        // x along the tangent keeps the base on the body; y is the ear's own direction.
        ears[i] = `matrix(${r2(side * t.x * w)},${r2(side * t.y * w)},${r2(-dx * h)},${r2(-dy * h)},${r2(p.x)},${r2(p.y)})`
      }
    }

    let whiskers = ''
    let whiskerAlpha = 0
    if (look.accessories.includes('whiskers') && frame.eyes.length === 2) {
      const [left, right] = frame.eyes.map(eyeCentre).sort((a, b) => a.x - b.x) as [EyeCentre, EyeCentre]
      const across = unit(right.x - left.x, right.y - left.y)
      const down = { x: -across.y, y: across.x }
      const gap = Math.hypot(right.x - left.x, right.y - left.y)
      const fx = (left.x + right.x) / 2 + down.x * 34
      const fy = (left.y + right.y) / 2 + down.y * 34
      whiskerAlpha = Math.min(left.alpha, right.alpha) * size
      for (const side of [-1, 1]) {
        const ox = fx + across.x * side * (gap / 2 + 16)
        const oy = fy + across.y * side * (gap / 2 + 16)
        for (const fan of [-13, 0, 13]) {
          const a = side * fan * DEG
          const dx = side * (across.x * Math.cos(a) - across.y * Math.sin(a))
          const dy = side * (across.x * Math.sin(a) + across.y * Math.cos(a))
          whiskers += `M${r2(ox - dx * 4)} ${r2(oy - dy * 4)}L${r2(ox + dx * WHISKER_LENGTH)} ${r2(oy + dy * WHISKER_LENGTH)}`
        }
      }
    }
    return { ears, whiskers, whiskerAlpha }
  }
}

interface EyeCentre { x: number; y: number; alpha: number }
/** An eye's centre is the translation of its matrix (engine.ts writes `matrix(a,b,c,d,e,f)`). */
function eyeCentre(eye: BotFrame['eyes'][number]): EyeCentre {
  const m = eye.matrix.slice(7, -1).split(',')
  return { x: Number(m[4]), y: Number(m[5]), alpha: eye.alpha }
}
