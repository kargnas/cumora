/**
 * What a working agent's bloub acts out for the kind of tool it runs. The
 * daemon classifies the engine's tool calls (server/src/fork/toolKind.ts) and
 * the server sends the kind as `fork.agent.tool`. During an act the body leans
 * back to the upper left and holds a prop at the lower right, big enough to
 * read on a 28px avatar, and looks at it with a fitting face: a page it reads
 * line by line, a pen writing on that page, a terminal, a magnifier, a globe.
 *
 * Props are drawn here, outside the vendored engine, in its viewBox units (the
 * ball at rest has radius 100 at the origin). Per frame only transforms,
 * opacity, a dash offset and short path strings change.
 */
import type { Look } from './engine/engine'
import type { ExpressionId } from './engine/expressions'

export const TOOL_KINDS = ['read', 'write', 'terminal', 'search', 'web'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]
export const isToolKind = (value: unknown): value is ToolKind =>
  typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value)

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Where the body goes during an act: its centre and its scale. */
export const LEAN = { x: -24, y: -24, scale: 0.7 }

/** The gaze that puts the leaning body's eyes on a point of the viewBox:
 *  positive yaw looks right and positive pitch looks up (the screen's y is
 *  flipped). The gain keeps a page's width inside the eyes' range. */
function aim(x: number, y: number): Look {
  const lx = (x - LEAN.x) / LEAN.scale
  const ly = (y - LEAN.y) / LEAN.scale
  return { yaw: clamp(lx * 0.28, -45, 45), pitch: clamp(-ly * 0.28, -45, 45), mix: 1, spin: 0, wander: 0.2 }
}

// The page and the terminal screen, held at the lower right, tilted a little.
const PAGE = { x: 48, y: 52, tilt: -6 }
const tiltCos = Math.cos((PAGE.tilt * Math.PI) / 180)
const tiltSin = Math.sin((PAGE.tilt * Math.PI) / 180)
const onPage = (x: number, y: number) => ({ x: PAGE.x + x * tiltCos - y * tiltSin, y: PAGE.y + x * tiltSin + y * tiltCos })
const LINE_Y = [-30, -12, 6, 24]
const LINE_LEN = [60, 48, 60, 36]
const LINE_X = -30

// One line read per 1.2 s; a page of four is written in 4 s, held, then cleared.
const READ_LINE = 1.2
const WRITE_LINE = 1
const WRITE_PAGE = 4.6

function lensAt(t: number) {
  const w = TAU / 2.6
  return { x: 44 + 26 * Math.sin(w * t), y: 48 + 12 * Math.sin(2 * w * t) }
}

const GLOBE = { x: 50, y: 54, r: 34 }

function penTip(t: number) {
  const c = t % WRITE_PAGE
  const i = Math.min(3, Math.floor(c / WRITE_LINE))
  const p = c >= 4 ? 1 : clamp(c / WRITE_LINE - i, 0, 1)
  // A fast small wiggle is the handwriting; after the page the pen lifts.
  const lift = c >= 4 ? 8 : 0
  return onPage(LINE_X + LINE_LEN[i] * p, LINE_Y[i] - 4 + 2.6 * Math.sin(c * TAU * 6) - lift)
}

/** Each kind's face (from the engine's catalogue) and where it looks at time t. */
export const ACTS: Record<ToolKind, { face: ExpressionId; look: (t: number) => Look }> = {
  read: {
    face: 'attentif',
    look: (t) => {
      const i = Math.floor(t / READ_LINE) % 4
      const p = (t % READ_LINE) / READ_LINE
      const at = onPage(LINE_X + LINE_LEN[i] * p, LINE_Y[i])
      return aim(at.x, at.y)
    },
  },
  write: { face: 'attentif', look: (t) => { const tip = penTip(t); return aim(tip.x, tip.y) } },
  terminal: { face: 'mefiant', look: (t) => aim(PAGE.x - 10 + 12 * Math.sin(t * 1.3), PAGE.y) },
  search: { face: 'curieux', look: (t) => { const at = lensAt(t); return aim(at.x, at.y) } },
  web: { face: 'surpris', look: (t) => aim(GLOBE.x + 6 * Math.sin(t * 1.1), GLOBE.y - 4) },
}

const NS = 'http://www.w3.org/2000/svg'
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const k in attrs) node.setAttribute(k, String(attrs[k]))
  return node
}

/** A prop's draw function: `t` is seconds since its act began. */
type Draw = (t: number) => void

const pageTransform = (dy = 0) => `translate(${PAGE.x} ${PAGE.y + dy}) rotate(${PAGE.tilt})`

function pageGroup(): { group: SVGGElement; lines: SVGPathElement[] } {
  const group = el('g', { transform: pageTransform() })
  group.append(el('rect', { x: -46, y: -56, width: 92, height: 112, rx: 11, fill: '#fff', stroke: 'currentColor', 'stroke-width': 8 }))
  const lines = LINE_Y.map((y, i) => el('path', {
    d: `M${LINE_X} ${y}h${LINE_LEN[i]}`, stroke: '#0a0a0c', 'stroke-width': 8, 'stroke-linecap': 'round', fill: 'none',
  }))
  group.append(...lines)
  return { group, lines }
}

const BUILD: Record<ToolKind, (layer: SVGGElement) => Draw> = {
  read(layer) {
    const { group, lines } = pageGroup()
    layer.append(group)
    return (t) => {
      const current = Math.floor(t / READ_LINE) % 4
      lines.forEach((line, i) => { line.setAttribute('opacity', i === current ? '0.85' : '0.22') })
      group.setAttribute('transform', pageTransform(1.8 * Math.sin(t * 2.4)))
    }
  },

  write(layer) {
    const { group, lines } = pageGroup()
    for (const [i, line] of lines.entries()) line.setAttribute('stroke-dasharray', String(LINE_LEN[i]))
    const pen = el('g', {})
    // The white outline keeps the pen apart from the body it crosses.
    pen.append(
      el('rect', { x: -8, y: -86, width: 16, height: 72, rx: 8, fill: 'currentColor', stroke: '#fff', 'stroke-width': 4, 'paint-order': 'stroke' }),
      el('path', { d: 'M-7.5 -16L7.5 -16L0 0Z', fill: '#2496e8', stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke', 'stroke-linejoin': 'round' }),
    )
    layer.append(group, pen)
    return (t) => {
      const c = t % WRITE_PAGE
      const fade = c >= 4 ? clamp(1 - (c - 4) / 0.6, 0, 1) : 1
      lines.forEach((line, i) => {
        line.setAttribute('stroke-dashoffset', String(LINE_LEN[i] * (1 - clamp(c / WRITE_LINE - i, 0, 1))))
        line.setAttribute('opacity', String(0.85 * fade))
      })
      const tip = penTip(t)
      pen.setAttribute('transform', `translate(${tip.x} ${tip.y}) rotate(26)`)
    }
  },

  terminal(layer) {
    const screen = el('g', { transform: pageTransform() })
    screen.append(el('rect', { x: -46, y: -48, width: 92, height: 96, rx: 11, fill: '#15171c', stroke: 'currentColor', 'stroke-width': 8 }))
    const output = [-26, -10].map((y) => el('path', { d: `M-32 ${y}h40`, stroke: '#8b8f98', 'stroke-width': 7, 'stroke-linecap': 'round' }))
    const cursor = el('rect', { x: -12, y: 12, width: 13, height: 18, rx: 2, fill: '#3ecf8e' })
    screen.append(...output, el('path', {
      d: 'M-33 12L-21 21L-33 30', stroke: '#3ecf8e', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none',
    }), cursor)
    layer.append(screen)
    return (t) => {
      cursor.setAttribute('opacity', t % 1 < 0.55 ? '1' : '0')
      // New output every 0.7 s: the lines change length.
      const tick = Math.floor(t / 0.7)
      output.forEach((line, i) => { line.setAttribute('d', `M-32 ${i ? -10 : -26}h${22 + ((tick * 37 + i * 23) % 38)}`) })
    }
  },

  search(layer) {
    const glass = el('g', {})
    glass.append(
      el('path', { d: 'M22 22L50 50', stroke: 'currentColor', 'stroke-width': 13, 'stroke-linecap': 'round' }),
      el('circle', { r: 30, fill: 'rgba(255,255,255,0.85)', stroke: 'currentColor', 'stroke-width': 10 }),
    )
    layer.append(glass)
    return (t) => {
      const at = lensAt(t)
      glass.setAttribute('transform', `translate(${at.x} ${at.y})`)
    }
  },

  web(layer) {
    const globe = el('g', { transform: `translate(${GLOBE.x} ${GLOBE.y})` })
    // Two meridians half a turn apart sweep across the face as it spins.
    const meridians = [0, 1].map(() => el('ellipse', { ry: GLOBE.r, fill: 'none', stroke: '#fff', 'stroke-width': 4, opacity: 0.85 }))
    globe.append(
      el('circle', { r: GLOBE.r, fill: '#3b93f0', stroke: 'currentColor', 'stroke-width': 7 }),
      el('path', { d: `M${-GLOBE.r} 0h${GLOBE.r * 2}`, stroke: '#fff', 'stroke-width': 4, opacity: 0.85 }),
      ...meridians,
    )
    layer.append(globe)
    return (t) => {
      meridians.forEach((m, i) => { m.setAttribute('rx', String(Math.abs(GLOBE.r * Math.cos(t * 2.2 + i * Math.PI / 2)))) })
      globe.setAttribute('transform', `translate(${GLOBE.x} ${GLOBE.y + 1.8 * Math.sin(t * 2.4)})`)
    }
  },
}

/** Draws the props of one view into `layer`: the act playing and one leaving,
 *  each faded by its presence (0 to 1). */
export function createProps(layer: SVGGElement) {
  const built = new Map<ToolKind, { group: SVGGElement; draw: Draw }>()
  const shown = new Set<ToolKind>()
  return (acts: ReadonlyArray<{ kind: ToolKind; t: number; presence: number }>) => {
    for (const kind of shown) {
      if (acts.some((a) => a.kind === kind)) continue
      built.get(kind)?.group.setAttribute('display', 'none')
      shown.delete(kind)
    }
    for (const act of acts) {
      let b = built.get(act.kind)
      if (!b) {
        const group = el('g', {})
        layer.append(group)
        b = { group, draw: BUILD[act.kind](group) }
        built.set(act.kind, b)
      }
      shown.add(act.kind)
      // A prop rises into place as it comes and sinks as it goes.
      b.group.removeAttribute('display')
      b.group.setAttribute('opacity', String(act.presence))
      b.group.setAttribute('transform', `translate(0 ${(1 - act.presence) * 14})`)
      b.draw(act.t)
    }
  }
}
