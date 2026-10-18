/**
 * Draws bloub engine frames into an <svg> by setting attributes, the layers of
 * bloub's BloubBot.vue without Vue: React renders the empty <svg> once and
 * every frame after that is attribute writes.
 *
 * Two departures from BloubBot.vue, both because an avatar sits on surfaces
 * of every colour (rows, selections, bubbles, light and dark):
 * - No backing in the page colour. The eyes are holes in the body that show
 *   the real surface, and the halves of the rings and the burst particles
 *   that pass behind the body are masked out by the body instead.
 * - Every ink fill is currentColor, so the colour (and its dark-mode swap)
 *   comes from CSS (`.nx-ink`), and the depth haze of the burst particles is
 *   opacity over that colour rather than a mix with a known page colour.
 */
import { NOTIF_BLUE } from './engine/decor'
import type { BotFrame } from './engine/engine'
import { RAYON } from './engine/repere'

const NS = 'http://www.w3.org/2000/svg'
/** Half the viewBox. bloub frames its ball of radius RAYON in 158; 120 makes
 *  the ball fill an avatar the way a portrait does, and the rings, which reach
 *  about 145, draw past the box (the svg's overflow is visible). */
export const VIEW_HALF = 120
export const VIEW_BOX = `${-VIEW_HALF} ${-VIEW_HALF} ${VIEW_HALF * 2} ${VIEW_HALF * 2}`
/** Mask regions cover everything an engine frame can draw, rings included. */
const AREA = { x: -200, y: -200, width: 400, height: 400 }
/** The ball at rest, shown until the engine has loaded. */
const BALL = `M${-RAYON} 0a${RAYON} ${RAYON} 0 1 0 ${RAYON * 2} 0a${RAYON} ${RAYON} 0 1 0 ${-RAYON * 2} 0Z`

let seq = 0

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const k in attrs) node.setAttribute(k, String(attrs[k]))
  return node
}

type Dot = BotFrame['dots'][number]
interface Arc { grad: SVGLinearGradientElement; stops: SVGStopElement[]; back: SVGPathElement; front: SVGPathElement }

/** Builds the layers inside `svg` and returns the function that draws a frame. */
export function createView(svg: SVGSVGElement): (frame: BotFrame) => void {
  const id = `nx-bloub-${seq++}`
  const defs = el('defs')
  const faceMask = el('mask', { id: `${id}-face`, maskUnits: 'userSpaceOnUse', ...AREA })
  const faceBody = el('path', { fill: '#fff', d: BALL })
  const eyes = [el('path', { fill: '#000', opacity: 0 }), el('path', { fill: '#000', opacity: 0 })]
  const notch = el('circle', { fill: '#000', r: 0 })
  faceMask.append(faceBody, ...eyes, notch)
  const behindMask = el('mask', { id: `${id}-behind`, maskUnits: 'userSpaceOnUse', ...AREA })
  const behindBody = el('path', { fill: '#000', d: BALL })
  behindMask.append(el('rect', { fill: '#fff', ...AREA }), behindBody)
  defs.append(faceMask, behindMask)

  const behind = el('g', { mask: `url(#${id}-behind)` })
  const arcsBack = el('g', { fill: 'none', 'stroke-linecap': 'round' })
  const dotsBack = el('g')
  behind.append(arcsBack, dotsBack)
  const body = el('g', { mask: `url(#${id}-face)` })
  body.append(el('rect', { fill: 'currentColor', ...AREA }))
  const dotsFront = el('g')
  const notif = el('circle', { fill: NOTIF_BLUE, r: 0 })
  const arcsFront = el('g', { fill: 'none', 'stroke-linecap': 'round' })
  svg.replaceChildren(defs, behind, body, dotsFront, notif, arcsFront)

  const arcs = new Map<string, Arc>()
  const back: SVGElement[] = []
  const front: SVGElement[] = []

  function syncDots(group: SVGGElement, pool: SVGElement[], dots: readonly Dot[]) {
    while (pool.length > dots.length) pool.pop()?.remove()
    dots.forEach((dot, i) => {
      const tag = dot.d ? 'path' : 'circle'
      let node = pool[i]
      if (!node || node.tagName !== tag) {
        const fresh = el(tag)
        if (node) node.replaceWith(fresh)
        else group.append(fresh)
        pool[i] = fresh
        node = fresh
      }
      node.setAttribute('fill', dot.color ?? 'currentColor')
      node.setAttribute('opacity', String(dot.opacity * (dot.color || dot.depth === undefined ? 1 : dot.depth)))
      if (dot.d) {
        node.setAttribute('d', dot.d)
        node.setAttribute('transform', `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`)
      } else {
        node.setAttribute('cx', String(dot.x))
        node.setAttribute('cy', String(dot.y))
        node.setAttribute('r', String(dot.r))
      }
    })
  }

  return (f) => {
    faceBody.setAttribute('d', f.bodyPath)
    behindBody.setAttribute('d', f.bodyPath)
    body.setAttribute('opacity', String(f.bodyAlpha))
    for (let i = 0; i < 2; i++) {
      const eye = f.eyes[i]
      if (!eye) {
        eyes[i].setAttribute('opacity', '0')
        continue
      }
      eyes[i].setAttribute('d', eye.d)
      eyes[i].setAttribute('transform', eye.matrix)
      eyes[i].setAttribute('opacity', String(eye.alpha))
    }
    for (const [node, at] of [[notch, f.notch], [notif, f.notif]] as const) {
      node.setAttribute('r', String(at?.r ?? 0))
      if (!at) continue
      node.setAttribute('cx', String(at.x))
      node.setAttribute('cy', String(at.y))
    }
    syncDots(dotsBack, back, f.dotsBehind ? f.dots : [])
    syncDots(dotsFront, front, f.dotsBehind ? [] : f.dots)

    const seen = new Set<string>()
    for (const a of f.arcs) {
      seen.add(a.id)
      let n = arcs.get(a.id)
      if (!n) {
        const gradId = `${id}-${a.id}`
        n = {
          grad: el('linearGradient', { id: gradId, gradientUnits: 'userSpaceOnUse' }),
          stops: [],
          back: el('path', { stroke: `url(#${gradId})` }),
          front: el('path', { stroke: `url(#${gradId})` }),
        }
        defs.append(n.grad)
        arcsBack.append(n.back)
        arcsFront.append(n.front)
        arcs.set(a.id, n)
      }
      const g = a.grad
      n.grad.setAttribute('x1', String(g.x1))
      n.grad.setAttribute('y1', String(g.y1))
      n.grad.setAttribute('x2', String(g.x2))
      n.grad.setAttribute('y2', String(g.y2))
      while (n.stops.length < g.stops.length) {
        const stop = el('stop')
        n.grad.append(stop)
        n.stops.push(stop)
      }
      g.stops.forEach((color, i) => {
        n.stops[i].setAttribute('offset', String(i / (g.stops.length - 1)))
        n.stops[i].setAttribute('stop-color', color)
      })
      for (const [path, d] of [[n.back, a.back], [n.front, a.front]] as const) {
        path.setAttribute('d', d)
        path.setAttribute('stroke-width', String(a.width))
        path.setAttribute('opacity', String(a.opacity))
      }
    }
    for (const [key, n] of arcs) {
      if (seen.has(key)) continue
      n.grad.remove()
      n.back.remove()
      n.front.remove()
      arcs.delete(key)
    }
  }
}
