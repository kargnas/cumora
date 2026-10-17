/**
 * Carrying a card between and within columns.
 *
 * Mouse: press and move a few pixels. Touch: press and hold, then move;
 * a held card released without moving opens its menu instead, the same
 * long-press menu every other list in the redesign has. While a card is
 * carried a ghost follows the pointer, the card leaves its list and a
 * placeholder of its height marks the drop slot; the other cards glide
 * around it through their layout animations. Dropping settles the ghost
 * into the slot, then commits through the store's optimistic move.
 *
 * Touch uses Touch Events bound to the touched node itself. The carried card
 * is unmounted, and the browser keeps sending touchmove/touchend to that
 * original node even after React removes it; listeners anywhere else would
 * go deaf, and the page would start scrolling under the finger.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { animate, useMotionValue, type MotionValue } from 'framer-motion'
import { mediumHaptic } from '@/lib/native'
import { useBoards } from '@/stores/boards'
import type { BoardCard, BoardSnapshot } from '@/types'
import { T_FAST, T_QUICK } from '../../ui/primitives'

const HOLD_MS = 350 // touch: how long a finger rests before the card lifts
const MOUSE_SLOP = 4 // px of mouse travel that turns a press into a drag
const TOUCH_SLOP = 8 // px a resting finger may wander; more means it is scrolling
const EDGE = 48 // px from a scroller's edge where auto-scroll starts
const MAX_SPEED = 16 // px per frame right at the edge

const EMPTY: BoardCard[] = []

/** A column's cards in board order. */
export function cardsIn(snap: BoardSnapshot | undefined, columnId: string): BoardCard[] {
  if (!snap) return EMPTY
  return snap.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position)
}

/** What the board renders while a card is carried. `index` counts the cards
 *  of column `to` without the carried one, the same index the store's move
 *  takes. */
export interface DragView {
  card: BoardCard
  to: string
  index: number
  w: number
  h: number
}

export interface Ghost {
  x: MotionValue<number>
  y: MotionValue<number>
  scale: MotionValue<number>
  rotate: MotionValue<number>
}

export interface DragBind {
  onPointerDown: (e: React.PointerEvent<HTMLElement>, card: BoardCard) => void
  onTouchStart: (e: React.TouchEvent<HTMLElement>, card: BoardCard) => void
  /** A press is being tracked: Android fires `contextmenu` on long-press,
   *  which must not open a second menu on top of the drag. */
  busy: () => boolean
}

interface Gesture {
  card: BoardCard
  from: string
  origin: number
  sx: number
  sy: number
  px: number
  py: number
  /** Grab offset inside the card, so the ghost does not jump to the pointer. */
  dx: number
  dy: number
  w: number
  h: number
  touch: boolean
  lifted: boolean
  moved: boolean
  settling: boolean
  list: HTMLElement | null
  raf: number
  off: () => void
}

/** The click a browser may still fire after a drop (or after a long-press
 *  opened the menu) must not open the card or close the fresh menu. */
function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 350)
}

/** Auto-scroll speed: negative near the start edge, positive near the end. */
function edgeSpeed(toStart: number, toEnd: number): number {
  if (toStart < EDGE) return -Math.ceil(MAX_SPEED * (1 - Math.max(toStart, 0) / EDGE))
  if (toEnd < EDGE) return Math.ceil(MAX_SPEED * (1 - Math.max(toEnd, 0) / EDGE))
  return 0
}

const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi

export function useCardDrag(
  boardId: string,
  canvas: RefObject<HTMLElement>,
  onHoldMenu: (cardId: string, x: number, y: number) => void,
): { view: DragView | null; ghost: Ghost; bind: DragBind } {
  const [view, setView] = useState<DragView | null>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const scale = useMotionValue(1)
  const rotate = useMotionValue(0)
  const holdMenu = useRef(onHoldMenu)
  holdMenu.current = onHoldMenu

  // Handlers read refs only, so memoized cards receive one stable set.
  const ctl = useMemo(() => {
    let g: Gesture | null = null
    let shown: DragView | null = null
    const show = (v: DragView | null) => {
      shown = v
      setView(v)
    }

    /** Pick the drop slot under the pointer: the nearest column list, then
     *  the number of cards whose middle is above the pointer. offsetTop is
     *  the layout position, which ignores the transforms of cards that are
     *  still gliding, so the slot cannot flicker while they move. */
    const retarget = () => {
      const host = canvas.current
      if (!g || !shown || !host) return
      let best: HTMLElement | null = null
      let bestD = Number.POSITIVE_INFINITY
      for (const el of host.querySelectorAll<HTMLElement>('[data-col-list]')) {
        const r = el.getBoundingClientRect()
        const d = g.px < r.left ? r.left - g.px : g.px > r.right ? g.px - r.right : 0
        if (d < bestD) { bestD = d; best = el }
      }
      if (!best) return
      g.list = best
      const top = best.getBoundingClientRect().top - best.scrollTop
      let index = 0
      for (const el of best.children) {
        if (el instanceof HTMLElement && el.dataset.card && top + el.offsetTop + el.offsetHeight / 2 < g.py) index++
      }
      const to = best.dataset.colList ?? shown.to
      if (to !== shown.to || index !== shown.index) show({ ...shown, to, index })
    }

    const tick = () => {
      if (!g || !g.lifted || g.settling) return
      let scrolled = false
      const host = canvas.current
      if (host) {
        const r = host.getBoundingClientRect()
        const v = within(g.py, r.top, r.bottom) ? edgeSpeed(g.px - r.left, r.right - g.px) : 0
        if (v) {
          const before = host.scrollLeft
          host.scrollLeft += v
          scrolled = host.scrollLeft !== before
        }
      }
      const list = g.list
      if (list) {
        const r = list.getBoundingClientRect()
        const v = within(g.px, r.left, r.right) && within(g.py, r.top, r.bottom) ? edgeSpeed(g.py - r.top, r.bottom - g.py) : 0
        if (v) {
          const before = list.scrollTop
          list.scrollTop += v
          scrolled = scrolled || list.scrollTop !== before
        }
      }
      if (scrolled) retarget()
      g.raf = requestAnimationFrame(tick)
    }

    const begin = (card: BoardCard, el: HTMLElement, px: number, py: number, touch: boolean): Gesture | null => {
      const origin = cardsIn(useBoards.getState().snapshots[boardId], card.columnId).findIndex((c) => c.id === card.id)
      if (origin < 0) return null
      const r = el.getBoundingClientRect()
      g = {
        card, from: card.columnId, origin, sx: px, sy: py, px, py,
        dx: px - r.left, dy: py - r.top, w: r.width, h: r.height,
        touch, lifted: false, moved: false, settling: false, list: null, raf: 0, off: () => {},
      }
      return g
    }

    const lift = () => {
      if (!g || g.lifted) return
      g.lifted = true
      if (g.touch) void mediumHaptic()
      x.set(g.px - g.dx)
      y.set(g.py - g.dy)
      animate(scale, 1.03, T_QUICK)
      animate(rotate, 1.5, T_QUICK)
      document.documentElement.classList.add('nx-boards-dragging')
      show({ card: g.card, to: g.from, index: g.origin, w: g.w, h: g.h })
      g.raf = requestAnimationFrame(tick)
    }

    const track = (px: number, py: number) => {
      if (!g) return
      g.px = px
      g.py = py
      if (!g.lifted || g.settling) return
      x.set(px - g.dx)
      y.set(py - g.dy)
      retarget()
    }

    /** Where the placeholder sits, from layout offsets for the same reason
     *  as in retarget. */
    const slot = (): { left: number; top: number } | null => {
      const ph = canvas.current?.querySelector<HTMLElement>('[data-placeholder]')
      const list = ph?.parentElement
      if (!ph || !list) return null
      const r = list.getBoundingClientRect()
      return { left: r.left + ph.offsetLeft - list.scrollLeft, top: r.top + ph.offsetTop - list.scrollTop }
    }

    const settle = (then: () => void) => {
      if (!g) return
      g.settling = true
      g.off()
      cancelAnimationFrame(g.raf)
      const to = slot()
      if (!to) { then(); return }
      Promise.all([
        animate(x, to.left, T_FAST),
        animate(y, to.top, T_FAST),
        animate(scale, 1, T_FAST),
        animate(rotate, 0, T_FAST),
      ]).then(then, then)
    }

    const finish = () => {
      if (!g) return
      g.off()
      cancelAnimationFrame(g.raf)
      g = null
      document.documentElement.classList.remove('nx-boards-dragging')
      show(null)
    }

    /** A press that never lifted: nothing to undo. */
    const release = () => {
      g?.off()
      g = null
    }

    const drop = () => {
      const gs = g
      if (!gs || !shown) { finish(); return }
      swallowNextClick()
      settle(() => {
        const v = shown
        // Same tick as finish(): the moved card mounts exactly where the
        // placeholder was, so nothing jumps when the ghost disappears.
        if (v && (v.to !== gs.from || v.index !== gs.origin)) {
          void useBoards.getState().moveCardOptimistic(boardId, v.card.id, v.to, v.index)
        }
        finish()
      })
    }

    /** Put the card back where it came from. */
    const cancel = (then: () => void = finish) => {
      const gs = g
      if (!gs) return
      if (!gs.lifted || !shown) { release(); return }
      // Commit the placeholder's return now, so the ghost settles onto the
      // origin slot instead of the last hovered one.
      const back = { ...shown, to: gs.from, index: gs.origin }
      flushSync(() => show(back))
      settle(then)
    }

    const onPointerDown = (e: React.PointerEvent<HTMLElement>, card: BoardCard) => {
      if (e.pointerType === 'touch' || e.button !== 0 || g) return
      const gs = begin(card, e.currentTarget, e.clientX, e.clientY, false)
      if (!gs) return
      const move = (ev: PointerEvent) => {
        if (!gs.lifted && Math.hypot(ev.clientX - gs.sx, ev.clientY - gs.sy) > MOUSE_SLOP) {
          gs.px = ev.clientX
          gs.py = ev.clientY
          lift()
        }
        track(ev.clientX, ev.clientY)
      }
      // Without a lift this was a click, and the card's own onClick opens it.
      const up = () => (gs.lifted ? drop() : release())
      const abort = () => cancel()
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !gs.lifted) return
        ev.preventDefault()
        ev.stopPropagation()
        cancel()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', abort)
      window.addEventListener('keydown', key, true)
      gs.off = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', abort)
        window.removeEventListener('keydown', key, true)
      }
    }

    const onTouchStart = (e: React.TouchEvent<HTMLElement>, card: BoardCard) => {
      const t = e.touches[0]
      if (e.touches.length !== 1 || !t || g) return
      const gs = begin(card, e.currentTarget, t.clientX, t.clientY, true)
      if (!gs) return
      const node = e.target
      const timer = window.setTimeout(lift, HOLD_MS)
      const move = (ev: TouchEvent) => {
        const p = ev.touches[0]
        if (!p) return
        const dist = Math.hypot(p.clientX - gs.sx, p.clientY - gs.sy)
        if (!gs.lifted) {
          // Moving before the hold completes is a scroll: let it be one.
          if (dist > TOUCH_SLOP) release()
          return
        }
        ev.preventDefault()
        if (dist > MOUSE_SLOP) gs.moved = true
        track(p.clientX, p.clientY)
      }
      const end = () => {
        if (!gs.lifted) { release(); return }
        if (gs.moved) { drop(); return }
        // Held and let go in place: the long-press menu.
        swallowNextClick()
        const { card: c, px, py } = gs
        cancel()
        holdMenu.current(c.id, px, py)
      }
      const abort = () => cancel()
      node.addEventListener('touchmove', move as EventListener, { passive: false })
      node.addEventListener('touchend', end)
      node.addEventListener('touchcancel', abort)
      gs.off = () => {
        window.clearTimeout(timer)
        node.removeEventListener('touchmove', move as EventListener)
        node.removeEventListener('touchend', end)
        node.removeEventListener('touchcancel', abort)
      }
    }

    /** The board went away mid-gesture: drop it without committing. */
    const dispose = () => {
      if (!g) return
      g.off()
      cancelAnimationFrame(g.raf)
      g = null
      document.documentElement.classList.remove('nx-boards-dragging')
    }

    return { bind: { onPointerDown, onTouchStart, busy: () => g !== null } satisfies DragBind, dispose }
  }, [boardId, canvas, x, y, scale, rotate])

  useEffect(() => ctl.dispose, [ctl])

  return { view, ghost: { x, y, scale, rotate }, bind: ctl.bind }
}
