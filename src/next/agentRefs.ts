/**
 * How anything that names an agent opens the agent menu (agentMenu.tsx). An
 * element marked `data-agent-id` opens it on a click, a right-click (a long
 * press on Android), Enter or Space while it has focus, and the context-menu
 * key. One set of listeners on the app's root element does it; they sit below
 * React's root, so they run before React's own handlers and stop them: a click
 * on a classic @mention chip opens the menu, not the chip's profile. Nothing
 * here imports React or a store, so tests drive it with plain objects.
 */
import type { Participant } from '@/types'
import { isDeletedAuthor } from './chat/deletedAuthor'

export interface AgentRefHooks {
  /** Opens the menu for `id`: at the pointer, or under `el` when there is none. */
  open(id: string, el: Element, at: { x: number; y: number } | null): void
  /** The menu is open, so its own keys (Enter on a highlighted row) go through. */
  isOpen(): boolean
  /** A long press became the menu. */
  held(): void
}

/** Props that let an avatar or a name open the menu; nothing for a person,
 *  nor for the stand-in of a deleted agent, which has no menu to open. */
export function agentRef(p: Participant | undefined, label?: string): Record<string, string | number> | undefined {
  if (p?.kind !== 'agent' || isDeletedAuthor(p.id)) return undefined
  const props: Record<string, string | number> = { 'data-agent-id': p.id, role: 'button', tabIndex: 0, 'aria-haspopup': 'menu' }
  if (label) props['aria-label'] = label
  return props
}

/** The same for a <button> (a Members row, a 1:1 room's header), which
 *  already has its role and its place in the tab order. */
export function agentButtonRef(p: Participant | undefined): Record<string, string> | undefined {
  return p?.kind === 'agent' ? { 'data-agent-id': p.id, 'aria-haspopup': 'menu' } : undefined
}

export function bindAgentRefs(root: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, hooks: AgentRefHooks): () => void {
  let touchedAt = Number.NEGATIVE_INFINITY
  const hit = (e: Event): { el: Element; id: string } | null => {
    const el = (e.target as Element | null)?.closest?.('[data-agent-id]')
    const id = el?.getAttribute('data-agent-id')
    return el && id ? { el, id } : null
  }
  const take = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onTouch = () => { touchedAt = Date.now() }
  const onClick = (e: Event) => {
    const h = hit(e)
    if (!h || (e as MouseEvent).button !== 0) return
    take(e)
    hooks.open(h.id, h.el, null)
  }
  const onContext = (e: Event) => {
    const h = hit(e)
    if (!h) return
    take(e)
    if (Date.now() - touchedAt < 1_000) hooks.held()
    // The keyboard's context-menu key reports no pointer position.
    const { clientX: x, clientY: y } = e as MouseEvent
    hooks.open(h.id, h.el, x === 0 && y === 0 ? null : { x, y })
  }
  const onKey = (e: Event) => {
    const { key } = e as KeyboardEvent
    if ((key !== 'Enter' && key !== ' ') || hooks.isOpen()) return
    const h = hit(e)
    if (!h || h.el !== e.target) return
    take(e)
    hooks.open(h.id, h.el, null)
  }
  root.addEventListener('touchstart', onTouch, { passive: true })
  root.addEventListener('click', onClick)
  root.addEventListener('contextmenu', onContext)
  root.addEventListener('keydown', onKey)
  return () => {
    root.removeEventListener('touchstart', onTouch)
    root.removeEventListener('click', onClick)
    root.removeEventListener('contextmenu', onContext)
    root.removeEventListener('keydown', onKey)
  }
}
