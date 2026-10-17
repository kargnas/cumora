/**
 * Agenda: the next AGENDA_DAYS days from the URL date, grouped by day with
 * sticky headings. Daily series fill this fast, so it is virtualized; rows
 * are memoized on the occurrence, whose event object the store replaces
 * only when that event changes.
 */
import { memo, useMemo } from 'react'
import { GroupedVirtuoso } from 'react-virtuoso'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import { useNT } from '../../i18n'
import { addDays, AGENDA_DAYS, byDay, DAY_LONG, describeRepeat, dtf, sameDay, TIME, type Occ, type Range } from './model'
import { CalLink, EDITOR_PARAMS, EventLink, ILock, KindMark } from './parts'

export const AgendaRow = memo(function AgendaRow({ o }: { o: Occ }) {
  const nt = useNT()
  const locale = useLocale()
  const { ev } = o
  const assignee = useParticipants((s) => (ev.kind === 'agent_task' && ev.assigneeId ? s.byId[ev.assigneeId]?.name : undefined))
  // A direct room is titled after the peer, who is already the assignee.
  const room = useConversations((s) => {
    const c = ev.kind === 'agent_task' && ev.targetConversationId ? s.list.find((x) => x.id === ev.targetConversationId) : undefined
    return c && c.kind !== 'direct' ? c.title : undefined
  })
  const f = dtf(locale, TIME)
  const endsToday = o.end.getTime() > o.start.getTime() && sameDay(o.start, new Date(o.end.getTime() - 1))
  const sub = [assignee, room, ev.recurrence ? describeRepeat(ev.recurrence, nt, locale) : null].filter(Boolean).join(' · ')
  return (
    <EventLink id={ev.id} className="nx-calendar-row" data-paused={ev.status === 'paused' || undefined}>
      <span className="nx-calendar-row__time nx-mono">
        {ev.allDay ? <b>{nt('calendar.allDay')}</b> : <><b>{f.format(o.start)}</b>{endsToday && <span>{f.format(o.end)}</span>}</>}
      </span>
      <KindMark ev={ev} size={28} />
      <span className="nx-calendar-row__main">
        <span className="nx-calendar-row__title">{ev.title || nt('calendar.untitled')}</span>
        {sub && <span className="nx-calendar-row__sub">{sub}</span>}
      </span>
      {ev.isPrivate && <span className="nx-calendar-row__lock" role="img" aria-label={nt('calendar.private')}><ILock /></span>}
      {ev.status === 'paused' && <span className="nx-chip">{nt('calendar.state.paused')}</span>}
    </EventLink>
  )
})

function DayHeading({ day }: { day: Date }) {
  const nt = useNT()
  const locale = useLocale()
  const today = new Date()
  const near = sameDay(day, today) ? nt('calendar.today') : sameDay(day, addDays(today, 1)) ? nt('calendar.tomorrow') : null
  const long = dtf(locale, DAY_LONG).format(day)
  return (
    <h2 className="nx-calendar-agenda__day" data-today={sameDay(day, today) || undefined}>
      {near ? <><b>{near}</b><span>{long}</span></> : <b>{long}</b>}
    </h2>
  )
}

export const Agenda = memo(function Agenda({ range, occs, loading }: { range: Range; occs: Occ[]; loading: boolean }) {
  const nt = useNT()
  const groups = useMemo(() => {
    const cells = byDay(occs, range)
    return range.days.map((day, i) => ({ day, items: cells[i] })).filter((g) => g.items.length > 0)
  }, [occs, range])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  if (loading) {
    return (
      <div className="nx-calendar-agenda" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="nx-calendar-row nx-calendar-row--skel">
            <span className="nx-skel" style={{ width: 48, height: 12 }} />
            <span className="nx-skel" style={{ width: 28, height: 28, borderRadius: 999 }} />
            <span className="nx-calendar-row__main">
              <span className="nx-skel" style={{ width: '55%', height: 12 }} />
              <span className="nx-skel" style={{ width: '80%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (groups.length === 0) {
    return (
      <div className="nx-empty nx-calendar-agenda__empty">
        <b>{nt('calendar.emptyRange', { n: AGENDA_DAYS })}</b>
        <CalLink className="nx-btn nx-btn--outline" params={{ ...EDITOR_PARAMS, new: '1' }}>{nt('calendar.new')}</CalLink>
      </div>
    )
  }
  return (
    <GroupedVirtuoso
      className="nx-calendar-agenda nx-scroll"
      style={{ height: '100%' }}
      groupCounts={groups.map((g) => g.items.length)}
      groupContent={(i) => <DayHeading day={groups[i].day} />}
      itemContent={(i) => <AgendaRow o={flat[i]} />}
    />
  )
})
