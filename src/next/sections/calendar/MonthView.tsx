/**
 * Month view. Wide windows get the classic month grid with event chips:
 * click a day for an hour at 9:00, drag across days (mouse) for an all-day
 * range, right-click for a menu. Narrow windows get the classic phone
 * layout: a compact grid with dots, and the selected day's events below it.
 */
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocale } from '@/lib/i18n'
import { useNT } from '../../i18n'
import { navigate } from '../../router'
import { Menu, useMenu } from '../../ui/primitives'
import { byDay, dateLabel, DAY_LONG, dtf, sameDay, TIME, wallTime, weekdayName, ymd, type Occ, type Range } from './model'
import { CalLink, EDITOR_PARAMS, EventLink, KindMark, newEventHref } from './parts'
import { AgendaRow } from './Agenda'

/** Chips per cell before "+N more"; matches the classic grid. */
const MAX_CHIPS = 3

function nineToTen(day: Date): [Date, Date] {
  return [new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9), new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10)]
}

function wholeDays(first: Date, last: Date): [Date, Date] {
  return [new Date(first.getFullYear(), first.getMonth(), first.getDate()), new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59)]
}

function Weekdays({ width }: { width: 'short' | 'narrow' }) {
  const locale = useLocale()
  return (
    <div className="nx-calendar-month__wk" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => <span key={i}>{weekdayName(i, locale, width)}</span>)}
    </div>
  )
}

const Chip = memo(function Chip({ o }: { o: Occ }) {
  const nt = useNT()
  const locale = useLocale()
  return (
    <EventLink
      id={o.ev.id}
      className="nx-calendar-chip"
      data-kind={o.ev.kind}
      data-paused={o.ev.status === 'paused' || undefined}
      title={o.ev.title}
    >
      <KindMark ev={o.ev} size={14} />
      {!o.ev.allDay && <time className="nx-mono" dateTime={o.start.toISOString()}>{dtf(locale, TIME).format(o.start)}</time>}
      <span>{o.ev.title || nt('calendar.untitled')}</span>
    </EventLink>
  )
})

interface Drag { a: number; b: number; moved: boolean }

export const MonthGrid = memo(function MonthGrid({ cursor, range, occs, loading }: { cursor: Date; range: Range; occs: Occ[]; loading: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const cells = useMemo(() => byDay(occs, range), [occs, range])
  const [drag, setDrag] = useState<Drag | null>(null)
  const gesture = useRef<{ drag: Drag; stop: () => void } | null>(null)
  const menu = useMenu()
  const [menuDay, setMenuDay] = useState<Date | null>(null)
  const { days } = range
  useEffect(() => () => gesture.current?.stop(), [])

  const cellAt = (x: number, y: number): number | null => {
    const raw = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-cell]')?.dataset.cell
    return raw === undefined ? null : Number(raw)
  }

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('a, button')) return
    const a = cellAt(e.clientX, e.clientY)
    if (a === null) return
    const mouse = e.pointerType === 'mouse'
    if (mouse) e.preventDefault()
    // Window listeners attach synchronously so a fast tap is never missed.
    const move = (ev: PointerEvent) => {
      const g = gesture.current
      if (!g || !mouse) return
      const b = cellAt(ev.clientX, ev.clientY)
      if (b === null || b === g.drag.b) return
      g.drag = { ...g.drag, b, moved: true }
      setDrag(g.drag)
    }
    const end = (ev: PointerEvent) => {
      const g = gesture.current
      g?.stop()
      if (!g || ev.type !== 'pointerup') return
      const lo = Math.min(g.drag.a, g.drag.b)
      const hi = Math.max(g.drag.a, g.drag.b)
      if (g.drag.moved && hi > lo) navigate(newEventHref(...wholeDays(days[lo], days[hi]), true))
      else navigate(newEventHref(...nineToTen(days[lo])))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      gesture.current = null
      setDrag(null)
    }
    gesture.current?.stop()
    gesture.current = { drag: { a, b: a, moved: false }, stop }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const onMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('a, button')) return
    const i = cellAt(e.clientX, e.clientY)
    if (i === null) return
    e.preventDefault()
    gesture.current?.stop()
    setMenuDay(days[i])
    menu.openAt({ x: e.clientX, y: e.clientY })
  }

  const lo = drag ? Math.min(drag.a, drag.b) : -1
  const hi = drag ? Math.max(drag.a, drag.b) : -1
  const today = new Date()

  return (
    <div className="nx-calendar-month" aria-busy={loading || undefined}>
      <Weekdays width="short" />
      <div
        className="nx-calendar-month__grid"
        style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(96px, 1fr))` }}
        onPointerDown={onDown}
        onContextMenu={onMenu}
      >
        {days.map((d, i) => {
          const items = cells[i]
          return (
            <div
              key={d.getTime()}
              className="nx-calendar-month__cell"
              data-cell={i}
              data-out={d.getMonth() !== cursor.getMonth() || undefined}
              data-picked={(drag?.moved && i >= lo && i <= hi) || undefined}
            >
              <CalLink
                className="nx-calendar-month__num nx-mono"
                data-today={sameDay(d, today) || undefined}
                params={{ view: 'day', date: ymd(d) }}
                replace
                aria-label={dtf(locale, DAY_LONG).format(d)}
              >{d.getDate()}</CalLink>
              {items.slice(0, MAX_CHIPS).map((o) => <Chip key={o.key} o={o} />)}
              {items.length > MAX_CHIPS && (
                <CalLink className="nx-calendar-month__more" params={{ view: 'day', date: ymd(d) }} replace>
                  {nt('calendar.more', { n: items.length - MAX_CHIPS })}
                </CalLink>
              )}
            </div>
          )
        })}
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={menuDay ? [
          { key: 'new', label: nt('calendar.newOn', { date: dateLabel(menuDay, locale) }), onSelect: () => navigate(newEventHref(...nineToTen(menuDay))) },
          { key: 'allday', label: nt('calendar.newAllDay'), onSelect: () => navigate(newEventHref(...wholeDays(menuDay, menuDay), true)) },
        ] : []}
      />
    </div>
  )
})

/** Phone month: dots under each date (filled = agent task, ring =
 *  personal, so the two differ by shape, not only color), then the
 *  selected day's list. The selected day is the URL's `date`. */
export const MonthCompact = memo(function MonthCompact({ cursor, range, occs, loading }: { cursor: Date; range: Range; occs: Occ[]; loading: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const cells = useMemo(() => byDay(occs, range), [occs, range])
  const { days } = range
  const picked = days.findIndex((d) => sameDay(d, cursor))
  const items = picked >= 0 ? cells[picked] : []
  const [from, to] = nineToTen(cursor)
  const today = new Date()
  return (
    <div className="nx-calendar-mini nx-scroll" aria-busy={loading || undefined}>
      <Weekdays width="narrow" />
      <div className="nx-calendar-mini__grid">
        {days.map((d, i) => (
          <CalLink
            key={d.getTime()}
            className="nx-calendar-mini__day"
            params={{ date: ymd(d) }}
            replace
            data-out={d.getMonth() !== cursor.getMonth() || undefined}
            data-today={sameDay(d, today) || undefined}
            aria-current={i === picked ? 'date' : undefined}
            aria-label={dtf(locale, DAY_LONG).format(d)}
          >
            <span className="nx-calendar-mini__num nx-mono">{d.getDate()}</span>
            <span className="nx-calendar-mini__dots" aria-hidden>
              {cells[i].slice(0, MAX_CHIPS).map((o) => <i key={o.key} data-kind={o.ev.kind} />)}
            </span>
          </CalLink>
        ))}
      </div>
      <section className="nx-calendar-mini__list" aria-label={dtf(locale, DAY_LONG).format(cursor)}>
        <header className="nx-calendar-mini__head">
          <h2>{dtf(locale, DAY_LONG).format(cursor)}</h2>
          <CalLink
            className="nx-btn nx-btn--sm nx-btn--outline"
            params={{ ...EDITOR_PARAMS, new: '1', from: wallTime(from), to: wallTime(to) }}
          >{nt('calendar.new')}</CalLink>
        </header>
        {items.length === 0
          ? <p className="nx-calendar-mini__empty">{loading ? nt('calendar.loading') : nt('calendar.emptyDay')}</p>
          : items.map((o) => <AgendaRow key={o.key} o={o} />)}
      </section>
    </div>
  )
})
