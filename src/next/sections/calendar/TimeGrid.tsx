/**
 * Day and week views: an all-day lane strip over a 24-hour grid. Empty space
 * creates events the way the classic grid did: click for an hour at that
 * slot, drag (mouse) for a range, right-click for a menu. A touch tap also
 * creates, while a touch drag scrolls (the browser cancels the pointer).
 */
import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useLocale } from '@/lib/i18n'
import { useNT } from '../../i18n'
import { useNow } from '../../hooks'
import { navigate } from '../../router'
import { Menu, useMenu } from '../../ui/primitives'
import {
  daySpan, dtf, DAY_LONG, layoutDay, sameDay, TIME, timeLabel, ymd, zoneName,
  type Occ, type Range, type Seg,
} from './model'
import { CalLink, EventLink, KindMark, newEventHref } from './parts'

/** px per hour; also published to CSS as --hour so both agree. */
const HOUR = 48
/** Drag and click snap, in minutes. */
const SNAP = 30
const PX_PER_MIN = HOUR / 60

interface Draft { day: number; a: number; b: number; moved: boolean }

/** Wall time on `day`; minutes past 1440 roll into the next day (24:00). */
function at(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
}

/** Selected range of a gesture: a click is one hour, a drag covers every
 *  slot it touched. */
function span(d: Draft): [number, number] {
  const lo = Math.min(d.a, d.b)
  return [lo, d.moved ? Math.max(d.a, d.b) + SNAP : lo + 60]
}

const Block = memo(function Block({ seg }: { seg: Seg }) {
  const locale = useLocale()
  const nt = useNT()
  const { occ } = seg
  const height = (seg.bottom - seg.top) * PX_PER_MIN
  const style: CSSProperties = {
    top: seg.top * PX_PER_MIN,
    height: height - 2,
    left: `calc(${(seg.col / seg.cols) * 100}% + 2px)`,
    width: `calc(${100 / seg.cols}% - 4px)`,
  }
  return (
    <EventLink
      id={occ.ev.id}
      className="nx-calendar-ev"
      data-kind={occ.ev.kind}
      data-paused={occ.ev.status === 'paused' || undefined}
      data-short={height < 36 || undefined}
      style={style}
    >
      <span className="nx-calendar-ev__title">
        <KindMark ev={occ.ev} size={14} />
        <span>{occ.ev.title || nt('calendar.untitled')}</span>
      </span>
      {height >= 36 && <span className="nx-calendar-ev__time nx-mono">{timeLabel(occ, locale)}</span>}
    </EventLink>
  )
})

/** Today's current-time rule. It ticks on its own so the clock never
 *  re-renders the grid. */
function NowLine({ days }: { days: Date[] }) {
  const now = new Date(useNow())
  const i = days.findIndex((d) => sameDay(d, now))
  if (i < 0) return null
  return (
    <span
      className="nx-calendar-grid__now"
      style={{
        top: (now.getHours() * 60 + now.getMinutes()) * PX_PER_MIN,
        left: `calc(var(--gutter) + (100% - var(--gutter)) * ${i / days.length})`,
        width: `calc((100% - var(--gutter)) / ${days.length})`,
      }}
      aria-hidden
    />
  )
}

export const TimeGrid = memo(function TimeGrid({ range, occs, loading }: { range: Range; occs: Occ[]; loading: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const { days } = range
  const scroller = useRef<HTMLDivElement>(null)
  const menu = useMenu()
  const [menuAt, setMenuAt] = useState<Date | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const gesture = useRef<{ draft: Draft; stop: () => void } | null>(null)

  const allDay = useMemo(() => occs
    .filter((o) => o.ev.allDay)
    .flatMap((o) => {
      const s = daySpan(o, range)
      return s ? [{ o, s }] : []
    }), [occs, range])
  const segs = useMemo(() => days.map((d) => layoutDay(occs, d)), [occs, days])

  // Open on the working part of the day: an hour before now when today is
  // on screen, else 8:00. Mount only, so paging weeks keeps the scroll.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const now = new Date()
    el.scrollTop = (days.some((d) => sameDay(d, now)) ? Math.max(0, now.getHours() - 1) : 8) * HOUR
  }, [])
  useEffect(() => () => gesture.current?.stop(), [])

  const minuteAt = (clientY: number, top: number) =>
    Math.max(0, Math.min(1440 - SNAP, Math.floor((clientY - top) / (SNAP * PX_PER_MIN)) * SNAP))

  const onColumnDown = (e: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (e.button !== 0 || (e.target as Element).closest('a')) return
    const top = e.currentTarget.getBoundingClientRect().top
    const a = minuteAt(e.clientY, top)
    const mouse = e.pointerType === 'mouse'
    if (mouse) e.preventDefault()
    // Listeners go on the window synchronously: a quick tap can lift
    // before an effect would have attached them, and a drag may leave
    // the column.
    const move = (ev: PointerEvent) => {
      const g = gesture.current
      if (!g || !mouse) return
      const b = minuteAt(ev.clientY, top)
      if (b === g.draft.b) return
      g.draft = { ...g.draft, b, moved: true }
      setDraft(g.draft)
    }
    const end = (ev: PointerEvent) => {
      const g = gesture.current
      g?.stop()
      if (!g || ev.type !== 'pointerup') return
      const [lo, hi] = span(g.draft)
      navigate(newEventHref(at(days[g.draft.day], lo), at(days[g.draft.day], hi)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      gesture.current = null
      setDraft(null)
    }
    gesture.current?.stop()
    gesture.current = { draft: { day, a, b: a, moved: false }, stop }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const onColumnMenu = (e: ReactMouseEvent<HTMLDivElement>, day: number) => {
    if ((e.target as Element).closest('a')) return
    e.preventDefault()
    // A long-press menu must not also create an event on lift.
    gesture.current?.stop()
    setMenuAt(at(days[day], minuteAt(e.clientY, e.currentTarget.getBoundingClientRect().top)))
    menu.openAt({ x: e.clientX, y: e.clientY })
  }

  const hourFmt = dtf(locale, { hour: 'numeric' })
  const today = new Date()

  return (
    <div
      ref={scroller}
      className="nx-calendar-grid nx-scroll"
      style={{ ['--hour' as string]: `${HOUR}px`, ['--days' as string]: days.length }}
      aria-busy={loading || undefined}
    >
      <div className="nx-calendar-grid__top">
        <div className="nx-calendar-grid__heads">
          <span className="nx-calendar-grid__zone nx-mono">{zoneName(days[0], locale)}</span>
          {days.map((d) => {
            const body = (
              <>
                <span className="nx-calendar-grid__wd">{dtf(locale, { weekday: 'short' }).format(d)}</span>
                <span className="nx-calendar-grid__num nx-mono">{d.getDate()}</span>
              </>
            )
            // In the week view a day's heading opens that day.
            return days.length > 1 ? (
              <CalLink
                key={d.getTime()}
                className="nx-calendar-grid__head"
                data-today={sameDay(d, today) || undefined}
                params={{ view: 'day', date: ymd(d) }}
                replace
                aria-label={dtf(locale, DAY_LONG).format(d)}
              >{body}</CalLink>
            ) : (
              <span key={d.getTime()} className="nx-calendar-grid__head" data-today={sameDay(d, today) || undefined}>{body}</span>
            )
          })}
        </div>
        <div className="nx-calendar-grid__allday">
          <span className="nx-calendar-grid__label">{nt('calendar.allDay')}</span>
          <div className="nx-calendar-grid__lanes">
            <div className="nx-calendar-grid__slots">
              {days.map((d) => (
                <button
                  key={d.getTime()}
                  type="button"
                  className="nx-calendar-grid__slot"
                  aria-label={nt('calendar.newAllDayOn', { date: dtf(locale, DAY_LONG).format(d) })}
                  onClick={() => navigate(newEventHref(d, at(d, 1439), true))}
                />
              ))}
            </div>
            {allDay.map(({ o, s }) => (
              <EventLink
                key={o.key}
                id={o.ev.id}
                className="nx-calendar-chip"
                data-kind={o.ev.kind}
                data-paused={o.ev.status === 'paused' || undefined}
                style={{ gridColumn: `${s[0] + 1} / ${s[1] + 2}` }}
              >
                <KindMark ev={o.ev} size={14} />
                <span>{o.ev.title || nt('calendar.untitled')}</span>
              </EventLink>
            ))}
          </div>
        </div>
      </div>
      <div className="nx-calendar-grid__body">
        <div className="nx-calendar-grid__rules" aria-hidden>
          {Array.from({ length: 23 }, (_, i) => <i key={i} style={{ top: (i + 1) * HOUR }} />)}
        </div>
        <div className="nx-calendar-grid__gutter" aria-hidden>
          {Array.from({ length: 23 }, (_, i) => (
            <span key={i} className="nx-mono" style={{ top: (i + 1) * HOUR }}>{hourFmt.format(at(days[0], (i + 1) * 60))}</span>
          ))}
        </div>
        {days.map((d, i) => {
          const [lo, hi] = draft && draft.day === i && draft.moved ? span(draft) : [0, 0]
          return (
            <div
              key={d.getTime()}
              className="nx-calendar-grid__col"
              data-today={sameDay(d, today) || undefined}
              onPointerDown={(e) => onColumnDown(e, i)}
              onContextMenu={(e) => onColumnMenu(e, i)}
            >
              {segs[i].map((s) => <Block key={s.occ.key} seg={s} />)}
              {hi > lo && (
                <span className="nx-calendar-grid__draft nx-mono" style={{ top: lo * PX_PER_MIN, height: (hi - lo) * PX_PER_MIN }}>
                  {dtf(locale, TIME).formatRange(at(d, lo), at(d, hi))}
                </span>
              )}
            </div>
          )
        })}
        <NowLine days={days} />
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={menuAt ? [
          {
            key: 'new',
            label: nt('calendar.newAt', { time: dtf(locale, TIME).format(menuAt) }),
            onSelect: () => navigate(newEventHref(menuAt, new Date(menuAt.getTime() + 3600_000))),
          },
          {
            key: 'allday',
            label: nt('calendar.newAllDay'),
            onSelect: () => navigate(newEventHref(at(menuAt, 0), at(menuAt, 1439), true)),
          },
        ] : []}
      />
    </div>
  )
})
