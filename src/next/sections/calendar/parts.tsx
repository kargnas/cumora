/**
 * Pieces every calendar view shares: links into the URL state, the mark that
 * tells agent tasks from personal events (the assignee's face vs. a calendar
 * glyph, never a colored edge), Run now (also on a room's Routines job), and
 * two glyphs the icon set lacks.
 */
import { memo, useEffect, useState, type AnchorHTMLAttributes, type SVGProps } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import type { CalendarEvent } from '@/types'
import { haptic } from '../../haptics'
import { useNT, type NT } from '../../i18n'
import { getRoute, linkClick, useRoute, withRoute } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { Spinner } from '../../ui/primitives'
import { IAgents, ICalendar, ICheck } from '../../ui/icons'
import { wallTime } from './model'

const RUN_STATES = ['dispatched', 'skipped', 'failed', 'duplicate', 'pending'] as const
type RunState = typeof RUN_STATES[number]

/** Dispatch status in words; a status the server adds later shows raw. */
export function runLabel(status: string, nt: NT): string {
  return (RUN_STATES as readonly string[]).includes(status) ? nt(`calendar.run.${status as RunState}`) : status
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Fires the event once now. Anything but a dispatch is a failure, shown
 *  under the button (its row wraps); success reads "Started" for a moment. */
export function RunNow({ ev, onRan }: { ev: CalendarEvent; onRan?: () => void }) {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!note?.ok) return
    const t = window.setTimeout(() => setNote(null), 2500)
    return () => window.clearTimeout(t)
  }, [note])
  return (
    <>
      <button
        type="button"
        className="nx-btn nx-btn--outline"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={async () => {
          setBusy(true)
          setNote(null)
          try {
            const r = await useCalendar.getState().runNow(ev.id)
            const state = runLabel(r.status, nt)
            haptic(r.status === 'dispatched' ? 'success' : 'error')
            setNote(r.status === 'dispatched'
              ? { ok: true, text: nt('calendar.started') }
              : { ok: false, text: nt('calendar.notStarted', { reason: r.error ? `${state}: ${r.error}` : state }) })
          } catch (e) {
            haptic('error')
            setNote({ ok: false, text: errText(e) })
          } finally {
            setBusy(false)
            onRan?.()
          }
        }}
      >
        {busy ? <Spinner /> : note?.ok ? <ICheck /> : <IPlay />}
        {note?.ok ? note.text : nt('calendar.runNow')}
      </button>
      {note && !note.ok && <p className="nx-field__error nx-calendar-detail__error" role="alert">{note.text}</p>}
    </>
  )
}

type Params = Record<string, string | null>

/** The editor's query params, cleared together when it closes. */
export const EDITOR_PARAMS = { new: null, edit: null, from: null, to: null, allday: null } satisfies Params

/** Editor for a new event; `from`/`to` prefill it in local wall time. */
export function newEventHref(from?: Date, to?: Date, allDay = false): string {
  return withRoute(getRoute(), {
    params: { ...EDITOR_PARAMS, new: '1', from: from ? wallTime(from) : null, to: to ? wallTime(to) : null, allday: allDay ? '1' : null },
  })
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  params: Params
  replace?: boolean
}

/** `<a>` to the current route with some params changed. It reads the route
 *  itself so a link inside a memoized grid never carries stale params. */
export function CalLink({ params, replace, onClick, ...rest }: LinkProps) {
  const route = useRoute()
  return <a {...rest} href={withRoute(route, { params })} onClick={(e) => { onClick?.(e); linkClick(e, { replace }) }} />
}

/** Opens an event's detail. Switching from one open event to another
 *  replaces the entry, so Back closes the detail instead of stepping
 *  through every event looked at. */
export function EventLink({ id, ...rest }: Omit<LinkProps, 'params' | 'replace'> & { id: string }) {
  const open = useRoute().search.get('event')
  return (
    <CalLink
      {...rest}
      params={{ ...EDITOR_PARAMS, event: id }}
      replace={open !== null}
      aria-current={open === id || undefined}
    />
  )
}

export const KindMark = memo(function KindMark({ ev, size }: { ev: CalendarEvent; size: number }) {
  const p = useParticipants((s) => (ev.kind === 'agent_task' && ev.assigneeId ? s.byId[ev.assigneeId] : undefined))
  if (p) return <Avatar p={p} size={size} />
  return (
    <span className="nx-calendar-mark" data-kind={ev.kind} style={{ width: size, height: size }} aria-hidden>
      {ev.kind === 'agent_task' ? <IAgents /> : <ICalendar />}
    </span>
  )
})

type P = SVGProps<SVGSVGElement>
/* Same 24px grid and 1.5 stroke as ui/icons, so they read as one family. */
const glyph: P = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
  'aria-hidden': true,
}
export const ILock = (p: P) => <svg {...glyph} {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
export const IPlay = (p: P) => <svg {...glyph} {...p}><path d="M8 5.5v13l10.5-6.5Z" /></svg>
