import { registerPlugin } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { isNativePlatform, nativePlatform } from '@/lib/native'

/**
 * Haptics for the redesign. Each kind names what happened, not how strong it
 * feels; AGENTS.md ("Haptics") says which interaction gets which kind.
 *
 * - press: a finger landed on one of the few places marked `data-haptic`.
 * - hold: a press turned into a hold (long-press menu, drag lift).
 * - sent: a message left.
 * - received: someone else's message arrived in the room on screen.
 * - success / error: an action the user waited on finished or failed.
 *
 * `press` comes from the touch layer (`bindPressHaptics`), never from a
 * component's own handler. Native apps only: the web and the desktop app have
 * nothing to vibrate. Fire the others where the screen changes, never from a
 * store, so they line up with the frame the user sees.
 */
export type HapticKind = 'press' | 'hold' | 'sent' | 'received' | 'success' | 'error'

// Android plays the system's own effects (android/.../NxHapticsPlugin.java);
// @capacitor/haptics would play fixed vibration waveforms there.
const NxHaptics = registerPlugin<{ perform(o: { kind: HapticKind }): Promise<void> }>('NxHaptics')

const ios: Record<HapticKind, () => Promise<void>> = {
  press: () => Haptics.impact({ style: ImpactStyle.Light }),
  hold: () => Haptics.impact({ style: ImpactStyle.Medium }),
  sent: () => Haptics.impact({ style: ImpactStyle.Light }),
  received: () => Haptics.notification({ type: NotificationType.Success }),
  success: () => Haptics.notification({ type: NotificationType.Success }),
  error: () => Haptics.notification({ type: NotificationType.Error }),
}

export function haptic(kind: HapticKind): void {
  if (!isNativePlatform()) return
  // A hold takes the touch over: lifting the finger afterwards is not a tap.
  if (kind === 'hold') endTouch()
  const run = nativePlatform() === 'android' ? NxHaptics.perform({ kind }) : ios[kind]()
  // A missing vibrator or an older APK without the plugin must not surface as
  // an unhandled rejection; the action itself already happened.
  run.catch(() => {})
}

/* ── Touch layer: the places marked data-haptic click when pressed ─── */

// Android's ViewConfiguration: a touch that holds still this long is a press,
// and one that moves this far is a scroll or a drag.
const TAP_TIMEOUT = 100
const TOUCH_SLOP = 8
// A tap's click arrives right after the lift. A lift without one (a tap that
// stopped a fling) did nothing, so it stays silent.
const CLICK_WINDOW = 300
const SCROLLS = /auto|scroll/

let touch: { id: number; x: number; y: number; at: number; pressed: boolean; frame: number; upAt: number } | null = null

function endTouch(): void {
  if (touch) cancelAnimationFrame(touch.frame)
  touch = null
}

function pressable(target: Element): Element | null {
  const el = target.closest('[data-haptic]')
  return el && !el.matches(':disabled, [aria-disabled="true"]') ? el : null
}

/** Inside a scroller a finger may be starting a scroll, so the press waits
 *  for TAP_TIMEOUT, like Android delays a list row's pressed state. Reads
 *  styles and scroll sizes once per touch-down, never in a frame. */
function inScroller(el: Element): boolean {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n)
    if (SCROLLS.test(s.overflowY) && n.scrollHeight > n.clientHeight) return true
    if (SCROLLS.test(s.overflowX) && n.scrollWidth > n.clientWidth) return true
  }
  return false
}

function press(): void {
  if (!touch) return
  touch.pressed = true
  haptic('press')
}

// Blink holds timers back while a fresh touch may still turn into a scroll, so a
// 100 ms timeout fires at about 200 ms; animation frames keep their pace.
function waitForPress(now: number): void {
  if (!touch) return
  if (now - touch.at < TAP_TIMEOUT) touch.frame = requestAnimationFrame(waitForPress)
  else press()
}

function onDown(e: PointerEvent): void {
  endTouch()
  if (e.pointerType !== 'touch' || !e.isPrimary || !(e.target instanceof Element)) return
  const el = pressable(e.target)
  if (!el) return
  touch = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, pressed: false, frame: 0, upAt: 0 }
  if (inScroller(el)) touch.frame = requestAnimationFrame(waitForPress)
  else press()
}

function onMove(e: PointerEvent): void {
  if (touch?.id === e.pointerId && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > TOUCH_SLOP) endTouch()
}

function onUp(e: PointerEvent): void {
  if (touch?.id !== e.pointerId) return
  cancelAnimationFrame(touch.frame)
  touch.upAt = e.timeStamp
}

function onCancel(e: PointerEvent): void {
  if (touch?.id === e.pointerId) endTouch()
}

function onClick(e: MouseEvent): void {
  const t = touch
  if (!t?.upAt) return
  endTouch()
  // A quick tap in a scroller lifts before its press could play; its click is
  // the first moment it is surely a tap.
  if (!t.pressed && e.timeStamp - t.upAt <= CLICK_WINDOW) haptic('press')
}

/** Plays `press` when a finger lands on a place marked `data-haptic`, for the
 *  whole app. NextApp binds it once. */
export function bindPressHaptics(): () => void {
  if (!isNativePlatform()) return () => {}
  const opts = { capture: true, passive: true }
  window.addEventListener('pointerdown', onDown, opts)
  window.addEventListener('pointermove', onMove, opts)
  window.addEventListener('pointerup', onUp, opts)
  window.addEventListener('pointercancel', onCancel, opts)
  window.addEventListener('click', onClick, opts)
  return () => {
    window.removeEventListener('pointerdown', onDown, opts)
    window.removeEventListener('pointermove', onMove, opts)
    window.removeEventListener('pointerup', onUp, opts)
    window.removeEventListener('pointercancel', onCancel, opts)
    window.removeEventListener('click', onClick, opts)
    endTouch()
  }
}
