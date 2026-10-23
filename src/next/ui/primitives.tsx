import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, PresenceContext } from 'framer-motion'
import { isMac } from '@/lib/runtime'
import { useNT } from '../i18n'
import { IX } from './icons'

/* ── Motion presets (transitions-dev tokens in seconds) ─────────────── */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const
export const T_QUICK = { duration: 0.15, ease: EASE_OUT }
export const T_FAST = { duration: 0.25, ease: EASE_OUT }
/** Springs for things a finger can throw: sheets, pushed screens. */
export const SPRING_SHEET = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 } as const

export const MOD = isMac ? '⌘' : 'Ctrl'
/** Spread onto an element to make it inert: React 18 drops an unknown boolean
 *  prop, while an empty string reaches the DOM. Inert keeps focus, clicks and
 *  screen readers out of something hidden only by its opacity. */
export const INERT = { inert: '' } as Record<string, string>

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="nx-kbd" aria-hidden>{children}</kbd>
}

export function Spinner({ large = false, label }: { large?: boolean; label?: string }) {
  const cls = large ? 'nx-spinner nx-spinner--lg' : 'nx-spinner'
  return label ? <span className={cls} role="status" aria-label={label} /> : <span className={cls} aria-hidden />
}

/* ── Pointer kind ───────────────────────────────────────────────────── */
function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

export const useCoarse = () => useMedia('(pointer: coarse)')

/* ── Layer root ─────────────────────────────────────────────────────── */
/** Floating layers portal into one node at the end of <body> so they stack
 *  above every region and keep `html.nx` token scope. */
function layerRoot(): HTMLElement {
  let el = document.getElementById('nx-layers')
  if (!el) {
    el = document.createElement('div')
    el.id = 'nx-layers'
    document.body.appendChild(el)
  }
  return el
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, layerRoot())
}

/* ── Tooltip ────────────────────────────────────────────────────────── */
interface TipState { text: string; x: number; y: number; below: boolean }
const TipContext = createContext<(s: TipState | null) => void>(() => {})

export function TooltipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null)
  return (
    <TipContext.Provider value={setTip}>
      {children}
      {tip && (
        <Portal>
          <div
            className="nx-tooltip"
            role="tooltip"
            style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '6px' : 'calc(-100% - 6px)'})` }}
          >{tip.text}</div>
        </Portal>
      )}
    </TipContext.Provider>
  )
}

/** Hover/focus tooltip for icon-only controls on fine pointers. Touch users
 *  get the aria-label through the accessibility tree and the menu label. */
export function useTooltip(text: string, place: 'above' | 'below' = 'above') {
  const set = useContext(TipContext)
  const timer = useRef<number | null>(null)
  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    set(null)
  }, [set])
  useEffect(() => hide, [hide])
  const show = useCallback((el: HTMLElement, delay: number) => {
    if (window.matchMedia('(pointer: coarse)').matches) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect()
      const below = place === 'below' || r.top < 40
      set({ text, x: r.left + r.width / 2, y: below ? r.bottom : r.top, below })
    }, delay)
  }, [place, set, text])
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, 450),
    onMouseLeave: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, 0) },
    onBlur: hide,
    onPointerDown: hide,
  }
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  shortcut?: string
  tipPlace?: 'above' | 'below'
  ring?: boolean
  small?: boolean
  active?: boolean
}

export function IconButton({ label, shortcut, tipPlace, ring, small, active, className, children, ...rest }: IconButtonProps) {
  const tip = useTooltip(shortcut ? `${label}  ${shortcut}` : label, tipPlace)
  const cls = ['nx-icon-btn', ring && 'nx-icon-btn--ring', small && 'nx-icon-btn--sm', className].filter(Boolean).join(' ')
  return (
    <button type="button" aria-label={label} data-active={active || undefined} className={cls} {...tip} {...rest}>
      {children}
    </button>
  )
}

/* ── Segmented tabs (sliding pill via shared layout) ───────────────── */
export interface SegItem<K extends string> { key: K; label: string; badge?: ReactNode }

export function Segmented<K extends string>({ items, value, onChange, label }: {
  items: Array<SegItem<K>>
  value: K
  onChange: (k: K) => void
  label: string
}) {
  const id = useId()
  return (
    <div className="nx-seg" role="tablist" aria-label={label}>
      {items.map((it) => {
        const on = it.key === value
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            className="nx-seg__tab"
            onClick={() => onChange(it.key)}
          >
            {on && (
              // framer-motion 11 never releases a removed layoutId element from
              // the AnimatePresence around it (fixed in 12.4.7), so a dialog or
              // sheet holding a switched control would leave its invisible layer
              // over the page. The pill has no exit, so it stays out of presence.
              <PresenceContext.Provider value={null}>
                <motion.span layoutId={`seg-${id}`} className="nx-seg__pill" transition={T_FAST} />
              </PresenceContext.Provider>
            )}
            {it.label}
            {it.badge}
          </button>
        )
      })}
    </div>
  )
}

/* ── Switch ─────────────────────────────────────────────────────────── */
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="nx-switch"
      onClick={() => onChange(!checked)}
    />
  )
}

/* ── Menu: anchored popover on fine pointers, bottom sheet on touch ── */
export interface MenuItem {
  key: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}
export type MenuEntry = MenuItem | 'sep' | { label: string }

export interface MenuAnchor { x: number; y: number; align?: 'start' | 'end' }

export function anchorFrom(el: Element, align: 'start' | 'end' = 'start'): MenuAnchor {
  const r = el.getBoundingClientRect()
  return { x: align === 'end' ? r.right : r.left, y: r.bottom + 4, align }
}

export function Menu({ open, anchor, entries, onClose, header }: {
  open: boolean
  anchor: MenuAnchor | null
  entries: MenuEntry[]
  onClose: () => void
  /** Extra content above the items (quick reactions on messages). */
  header?: ReactNode
}) {
  const coarse = useCoarse()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null)
  const [hi, setHi] = useState(-1)
  const items = entries.filter((e): e is MenuItem => typeof e === 'object' && 'key' in e && !e.disabled)

  useLayoutEffect(() => {
    if (!open || coarse || !anchor || !ref.current) return
    // Clamp into the viewport and flip above the anchor when there is no room.
    const r = ref.current.getBoundingClientRect()
    let left = anchor.align === 'end' ? anchor.x - r.width : anchor.x
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8))
    let top = anchor.y
    let origin = anchor.align === 'end' ? 'top right' : 'top left'
    if (top + r.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.y - r.height - 12)
      origin = anchor.align === 'end' ? 'bottom right' : 'bottom left'
    }
    setPos({ left, top, origin })
  }, [open, coarse, anchor])

  useEffect(() => {
    if (!open) { setPos(null); setHi(-1); return }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => (i + 1) % items.length) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => (i - 1 + items.length) % items.length) }
      if (e.key === 'Enter' && hi >= 0 && items[hi]) { e.preventDefault(); items[hi].onSelect(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, items, hi])

  const body = entries.map((e, i) => {
    if (e === 'sep') return <div key={`sep-${i}`} className="nx-menu__sep" aria-hidden />
    if (!('key' in e)) return <div key={`label-${i}`} className="nx-menu__label">{e.label}</div>
    return (
      <button
        key={e.key}
        type="button"
        role="menuitem"
        disabled={e.disabled}
        data-highlighted={items[hi]?.key === e.key || undefined}
        className={e.danger ? 'nx-menu__item nx-menu__item--danger' : 'nx-menu__item'}
        onMouseEnter={() => setHi(items.findIndex((x) => x.key === e.key))}
        onClick={() => { e.onSelect(); onClose() }}
      >
        {e.icon}
        <span>{e.label}</span>
        {e.shortcut && !coarse && <Kbd>{e.shortcut}</Kbd>}
      </button>
    )
  })

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <div className="nx-layer" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) onClose() }}>
            {coarse ? (
              <>
                <motion.div className="nx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T_FAST} onClick={onClose} />
                <motion.div
                  className="nx-sheet"
                  role="menu"
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '100%' }}
                  transition={SPRING_SHEET}
                  drag="y"
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0, bottom: 0.6 }}
                  onDragEnd={(_, info) => { if (info.offset.y > 80 || info.velocity.y > 500) onClose() }}
                >
                  <span className="nx-sheet__grip" aria-hidden />
                  {header}
                  {body}
                </motion.div>
              </>
            ) : (
              <motion.div
                ref={ref}
                className="nx-menu"
                role="menu"
                style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, ['--nx-origin' as string]: pos?.origin }}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: pos ? 1 : 0, scale: pos ? 1 : 0.96 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={T_QUICK}
              >
                {header}
                {body}
              </motion.div>
            )}
          </div>
        )}
      </AnimatePresence>
    </Portal>
  )
}

/** Open/close state + anchor for a Menu bound to a trigger element. */
export function useMenu() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  return {
    open: anchor !== null,
    anchor,
    close,
    openAt: setAnchor,
    toggleFrom: (el: Element, align: 'start' | 'end' = 'start') => setAnchor((a) => (a ? null : anchorFrom(el, align))),
  }
}

/* ── Modal sheet (dialogs: forms, editors) ─────────────────────────── */
export function Dialog({ open, onClose, title, children, wide = false }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  const coarse = useCoarse()
  const nt = useNT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <div className="nx-layer nx-dialog-layer">
            <motion.div className="nx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T_FAST} onClick={onClose} />
            <motion.section
              role="dialog"
              aria-modal="true"
              aria-label={title}
              className={wide ? 'nx-dialog nx-dialog--wide' : 'nx-dialog'}
              initial={coarse ? { y: '100%' } : { opacity: 0, scale: 0.97, y: 8 }}
              animate={coarse ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
              exit={coarse ? { y: '100%' } : { opacity: 0, scale: 0.97, y: 8 }}
              transition={coarse ? SPRING_SHEET : T_FAST}
            >
              <header className="nx-dialog__head">
                <h2>{title}</h2>
                <IconButton label={nt('common.close')} small onClick={onClose}><IX /></IconButton>
              </header>
              <div className="nx-dialog__body nx-scroll">{children}</div>
            </motion.section>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  )
}
