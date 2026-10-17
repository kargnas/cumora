/**
 * Calendar section: day, week, month and agenda views over the shared
 * calendar store, an event detail (docked on full windows, a side sheet on
 * split, a pushed screen on stack) and the classic EventEditor inside the
 * redesign's Dialog. The URL holds all of it:
 *   ?view=day|week|month|agenda &date=YYYY-MM-DD
 *   &event=<id> [&edit=1]   detail, then its editor
 *   &new=1 [&from=&to=YYYY-MM-DDTHH:mm &allday=1]   editor for a new event
 * `calendar.changed` WebSocket events keep the store (stores/calendar.ts)
 * current, so every view updates in place.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EventEditor } from '@/components/EventEditor'
import { useCalendar } from '@/stores/calendar'
import { useLocale } from '@/lib/i18n'
import { resolveIdPrefix } from '@/lib/useArtifactId'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import type { CalendarEvent } from '@/types'
import { useNT } from '../../i18n'
import { getRoute, goBack, navigate, withRoute, type Route } from '../../router'
import type { SectionProps } from '../types'
import { Dialog, IconButton, Segmented, Spinner, SPRING_SHEET, T_FAST } from '../../ui/primitives'
import { IChevronLeft, IChevronRight, IPlus } from '../../ui/icons'
import { expand, parseLocal, parseView, rangeLabel, rangeOf, shift, startOfDay, VIEWS, ymd, type Occ, type Range, type View } from './model'
import { CalLink, EDITOR_PARAMS } from './parts'
import { TimeGrid } from './TimeGrid'
import { MonthCompact, MonthGrid } from './MonthView'
import { Agenda } from './Agenda'
import { EventDetail } from './EventDetail'
import './calendar.css'

function closeDetail(): void {
  goBack(withRoute(getRoute(), { params: { ...EDITOR_PARAMS, event: null } }))
}

function findEvent(events: CalendarEvent[], raw: string): CalendarEvent | undefined {
  const id = resolveIdPrefix(raw, events, (e) => e.id)
  return events.find((e) => e.id === id)
}

function Toolbar({ view, cursor, range, stack }: { view: View; cursor: Date; range: Range; stack: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  // Paging and switching views change what is on screen, not what is
  // open, so they replace the entry: Back still leaves the section.
  const go = (params: Record<string, string | null>) => navigate(withRoute(getRoute(), { params }), { replace: true })
  const label = <h1 aria-live="polite">{rangeLabel(view, cursor, range, locale)}</h1>
  const prev = <IconButton label={nt('calendar.prev')} onClick={() => go({ date: ymd(shift(view, cursor, -1)) })}><IChevronLeft /></IconButton>
  const next = <IconButton label={nt('calendar.next')} onClick={() => go({ date: ymd(shift(view, cursor, 1)) })}><IChevronRight /></IconButton>
  const today = <button type="button" className="nx-btn nx-btn--sm nx-btn--outline" onClick={() => go({ date: null })}>{nt('calendar.today')}</button>
  const views = (
    <Segmented
      label={nt('calendar.views')}
      value={view}
      onChange={(v) => go({ view: v })}
      items={VIEWS.map((k) => ({ key: k, label: nt(`calendar.view.${k}`) }))}
    />
  )
  const create = { ...EDITOR_PARAMS, new: '1' }
  if (stack) {
    return (
      <header className="nx-calendar__head" data-stack="">
        <div className="nx-calendar__nav">{prev}{label}{next}</div>
        {today}
        <CalLink className="nx-icon-btn nx-icon-btn--ring" params={create} aria-label={nt('calendar.new')}><IPlus /></CalLink>
        {views}
      </header>
    )
  }
  return (
    <header className="nx-calendar__head">
      <div className="nx-calendar__nav">{prev}{next}{label}</div>
      {today}
      {views}
      <CalLink className="nx-btn nx-btn--primary" params={create}><IPlus />{nt('calendar.new')}</CalLink>
    </header>
  )
}

function ViewBody({ view, stack, cursor, range, occs, loading }: {
  view: View; stack: boolean; cursor: Date; range: Range; occs: Occ[]; loading: boolean
}) {
  if (view === 'agenda') return <Agenda range={range} occs={occs} loading={loading} />
  if (view === 'month') {
    return stack
      ? <MonthCompact cursor={cursor} range={range} occs={occs} loading={loading} />
      : <MonthGrid cursor={cursor} range={range} occs={occs} loading={loading} />
  }
  return <TimeGrid range={range} occs={occs} loading={loading} />
}

/** EventEditor in the redesign's Dialog. The editor draws its own modal
 *  shell; calendar.css flattens that shell inside `.nx-calendar-editor`. */
function EditorDialog({ route }: { route: Route }) {
  const nt = useNT()
  const q = route.search
  const creating = q.get('new') === '1'
  const editRaw = !creating && q.get('edit') === '1' ? q.get('event') : null
  const event = useCalendar((s) => (editRaw ? findEvent(s.events, editRaw) : undefined))
  const open = creating || event !== undefined
  const from = q.get('from')
  const to = q.get('to')
  const allDay = q.get('allday') === '1'
  const prefill = useMemo(() => {
    const start = parseLocal(from)
    return start ? { startAt: start, endAt: parseLocal(to), allDay } : null
  }, [from, to, allDay])

  // Dialog and EventEditor both close on Escape; only the first call may
  // step back, or the second would also close the detail underneath.
  const closing = useRef(false)
  useEffect(() => { if (open) closing.current = false }, [open])
  const close = useCallback(() => {
    const r = getRoute()
    if (closing.current || (r.search.get('new') !== '1' && r.search.get('edit') !== '1')) return
    closing.current = true
    const id = r.search.get('event')
    // Deleted from inside the editor: the detail it opened from is gone
    // too, so leave both in place rather than stepping back onto it.
    if (r.search.get('edit') === '1' && id && !findEvent(useCalendar.getState().events, id)) {
      navigate(withRoute(r, { params: { ...EDITOR_PARAMS, event: null } }), { replace: true })
    } else {
      goBack(withRoute(r, { params: EDITOR_PARAMS }))
    }
  }, [])

  return (
    <Dialog open={open} onClose={close} title={nt(creating ? 'calendar.newTitle' : 'calendar.editTitle')} wide>
      <div className="nx-calendar-editor">
        <EventEditor key={creating ? `new:${from ?? ''}:${to ?? ''}` : event?.id} event={creating ? null : event ?? null} prefill={prefill} onClose={close} />
      </div>
    </Dialog>
  )
}

/** Android's back button closes the editor, then the detail. It listens in
 *  the capture phase so it runs before the shell's handler, which would
 *  otherwise leave the section for Chats. */
function useHardwareBack(): void {
  useEffect(() => {
    const onBack = (e: Event) => {
      const r = getRoute()
      const editor = r.search.get('new') === '1' || r.search.get('edit') === '1'
      if (!editor && !r.search.get('event')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      goBack(withRoute(r, { params: editor ? EDITOR_PARAMS : { ...EDITOR_PARAMS, event: null } }))
    }
    window.addEventListener('cumora:hardware-back', onBack, true)
    return () => window.removeEventListener('cumora:hardware-back', onBack, true)
  }, [])
}

/** Escape closes the detail unless a menu or dialog is on top (they own
 *  Escape while open). */
function useEscapeCloses(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('#nx-layers .nx-layer')) return
      closeDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

/** Narrow layout: the detail slides over the calendar and follows a swipe
 *  back from anywhere, like a pushed chat. */
function Pushed({ children }: { children: ReactNode }) {
  const w = window.innerWidth
  const swipe = useSwipeBackProps(closeDetail)
  return (
    <motion.div
      className="nx-pushed"
      initial={{ x: w }}
      animate={{ x: 0 }}
      exit={{ x: w }}
      transition={SPRING_SHEET}
      {...swipe.props}
      style={{ ...swipe.props.style, zIndex: 1 }}
    >
      {children}
    </motion.div>
  )
}

export default function CalendarSection({ route, layout, stack }: SectionProps) {
  const nt = useNT()
  const q = route.search
  const view = parseView(q.get('view')) ?? (stack ? 'agenda' : 'week')
  const dateParam = q.get('date')
  const cursor = useMemo(() => parseLocal(dateParam) ?? startOfDay(new Date()), [dateParam])
  const range = useMemo(() => rangeOf(view, cursor), [view, cursor])
  const events = useCalendar((s) => s.events)
  const loaded = useCalendar((s) => s.loaded)
  const failed = useCalendar((s) => (!s.loaded && !s.loading ? s.error : null))
  const occs = useMemo(() => expand(events, range.start, range.end), [events, range])
  const eventId = q.get('event')
  const editorOpen = q.get('new') === '1' || q.get('edit') === '1'

  useEffect(() => { void useCalendar.getState().load() }, [])
  useHardwareBack()
  useEscapeCloses(eventId !== null && !editorOpen)

  const main = (
    <section className="nx-calendar__main" aria-label={nt('calendar.title')}>
      <Toolbar view={view} cursor={cursor} range={range} stack={stack} />
      <div className="nx-calendar__view" key={view}>
        {failed ? (
          <div className="nx-empty" role="alert">
            <b>{nt('calendar.loadFailed')}</b>
            <span className="nx-mono">{failed}</span>
            <button type="button" className="nx-btn nx-btn--outline" onClick={() => void useCalendar.getState().reload()}>{nt('calendar.retry')}</button>
          </div>
        ) : (
          <>
            <ViewBody view={view} stack={stack} cursor={cursor} range={range} occs={occs} loading={!loaded} />
            {/* Grids draw their frame at once; the agenda has its own skeleton. */}
            {!loaded && view !== 'agenda' && <div className="nx-calendar__busy"><Spinner large label={nt('calendar.loading')} /></div>}
          </>
        )}
      </div>
    </section>
  )
  const detail = eventId && <EventDetail key={eventId} rawId={eventId} stack={stack} onClose={closeDetail} />

  return (
    <>
      {stack ? (
        <div className="nx-stackview">
          <div className="nx-stackview__base" {...(eventId ? { inert: '' } : {})}>{main}</div>
          <AnimatePresence initial={false}>{eventId && <Pushed key="event">{detail}</Pushed>}</AnimatePresence>
        </div>
      ) : (
        <div className="nx-calendar" data-dock={layout === 'full' && eventId ? '' : undefined}>
          {main}
          {layout === 'full' ? (
            eventId && (
              <motion.div className="nx-calendar__dock" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={T_FAST}>
                {detail}
              </motion.div>
            )
          ) : (
            <AnimatePresence>
              {eventId && (
                <div className="nx-panel-overlay" key="sheet">
                  <motion.div className="nx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T_FAST} onClick={closeDetail} />
                  <motion.div className="nx-panel-sheet" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={SPRING_SHEET}>
                    {detail}
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          )}
        </div>
      )}
      {/* Outside the layout branches so a resize across 720px keeps a draft. */}
      <EditorDialog route={route} />
    </>
  )
}
