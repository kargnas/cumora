/**
 * Routines = recurring agent tasks (calendar `agent_task` events) that post
 * into this room, one row per job (`routines.ts` folds the daily events an
 * agent books for "every few hours" into one). A job opens in place
 * (`?routine=`) with its prompt, its times and the "every N hours" control;
 * a time opens the event itself as a panel peek. Pausing here is the same as
 * pausing it in Calendar.
 */
import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { useLocale, type Locale } from '@/lib/i18n'
import { nextOccurrenceOnOrAfter } from '@/lib/recurrence'
import type { CalendarEvent, Conversation } from '@/types'
import { clock, dateTime } from '../format'
import { haptic } from '../haptics'
import { useNT, type NT } from '../i18n'
import { getRoute, goBack, href, linkClick, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { IconButton, Spinner, Switch } from '../ui/primitives'
import { IChevronLeft, IChevronRight, IRepeat } from '../ui/icons'
import { describeRepeat } from '../sections/calendar/model'
import { everyHours, familiesOf, HOUR_STEPS, isDaily, memberAt, minuteOf, planFor, timesFor, titleFor, type Family } from './routines'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The active member that fires next, or null when every member is paused. */
function nextRun(events: CalendarEvent[]): { id: string; at: Date } | null {
  const now = new Date()
  let best: { id: string; at: Date } | null = null
  for (const e of events) {
    if (e.status !== 'active') continue
    const at = nextOccurrenceOnOrAfter(new Date(e.startAt), e.recurrence, now)
    if (at && (!best || at < best.at)) best = { id: e.id, at }
  }
  return best
}

function timeOfDay(minute: number, locale: Locale): string {
  return clock(new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60), locale)
}

function rhythm(hours: number, nt: NT): string {
  return hours === 24 ? nt('routines.onceADay') : hours === 1 ? nt('routines.everyHour') : nt('routines.everyHours', { n: hours })
}

function caption(f: Family, next: Date | null, nt: NT, locale: Locale): string {
  const first = f.events[0]
  const hours = everyHours(f)
  const several = f.events.length > 1
  const parts = [
    !first.recurrence ? nt('routines.once', { when: dateTime(first.startAt, locale) })
      : several && hours !== null ? rhythm(hours, nt)
        : several && isDaily(f) ? nt('routines.timesADay', { n: f.events.length })
          : `${describeRepeat(first.recurrence, nt, locale)} · ${clock(new Date(first.startAt), locale)}`,
  ]
  // A single event already says its time; a job of several names the next one.
  if (several && next) parts.push(nt('routines.next', { time: clock(next, locale) }))
  const paused = f.events.filter((e) => e.status === 'paused').length
  if (paused > 0 && paused < f.events.length) parts.push(nt('routines.paused', { n: paused }))
  return parts.join(' · ')
}

/** Pause or resume a set of events together (a whole job, or one time). */
function useToggle(events: CalendarEvent[]) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = async (on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await Promise.all(events
        .filter((e) => e.status === (on ? 'paused' : 'active'))
        .map((e) => useCalendar.getState().update(e.id, { status: on ? 'active' : 'paused' })))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, set }
}

/** A row's switch and chevron; a failed toggle wraps its error under the row. */
function RowEnd({ events, label }: { events: CalendarEvent[]; label: string }) {
  const { busy, error, set } = useToggle(events)
  const live = events.some((e) => e.status === 'active' || e.status === 'paused')
  return (
    <>
      {busy && <Spinner />}
      <Switch label={label} checked={events.some((e) => e.status === 'active')} disabled={busy || !live} onChange={set} />
      <IChevronRight aria-hidden />
      {error && <p className="nx-field__error nx-routine__error" role="alert">{error}</p>}
    </>
  )
}

/** A job with several times (or one that could have several) opens in place; a lone event opens directly. */
function opensAsJob(f: Family): boolean {
  return f.events.length > 1 || isDaily(f)
}

function FamilyRow({ f, face }: { f: Family; face: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const assignee = useParticipants((s) => (face && f.events[0].assigneeId ? s.byId[f.events[0].assigneeId] : undefined))
  const next = useMemo(() => nextRun(f.events), [f.events])
  const r = getRoute()
  const to = opensAsJob(f) ? withRoute(r, { params: { routine: f.id } }) : withRoute(r, { peek: { kind: 'event', id: f.id } })
  return (
    <div className="nx-row nx-routine" data-paused={!next || undefined}>
      <a className="nx-routine__open" href={to} onClick={linkClick}>
        {assignee ? <Avatar p={assignee} size={24} /> : <IRepeat />}
        <span className="nx-row__text">
          <span className="nx-routine__title">{f.title || nt('calendar.untitled')}</span>
          <span className="nx-row__hint">{caption(f, next?.at ?? null, nt, locale)}</span>
        </span>
      </a>
      <RowEnd events={f.events} label={nt('routines.active', { title: f.title })} />
    </div>
  )
}

/** When the event last ran. After an outage the scheduler skips missed runs
 *  and stamps `lastFiredAt` with the current time, so a stamp off the
 *  event's own clock time is not a run. */
function lastRun(e: CalendarEvent): string | null {
  if (!e.lastFiredAt) return null
  const d = new Date(e.lastFiredAt)
  return d.getHours() * 60 + d.getMinutes() === minuteOf(e) ? e.lastFiredAt : null
}

function TimeRow({ e, next, daily }: { e: CalendarEvent; next: boolean; daily: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const at = new Date(e.startAt)
  const ran = lastRun(e)
  const state = next ? nt('routines.nextUp') : ran ? nt('routines.ran', { when: dateTime(ran, locale) }) : ''
  return (
    <div className="nx-row nx-routine" data-paused={e.status !== 'active' || undefined}>
      <a className="nx-routine__open" href={withRoute(getRoute(), { peek: { kind: 'event', id: e.id } })} onClick={linkClick}>
        <span className={daily ? 'nx-mono' : undefined}>
          {daily ? clock(at, locale) : `${describeRepeat(e.recurrence, nt, locale)} · ${clock(at, locale)}`}
        </span>
        <span className="nx-routine__state" data-next={next || undefined}>{state}</span>
      </a>
      <RowEnd events={[e]} label={nt('routines.active', { title: e.title })} />
    </div>
  )
}

/** "Every N hours" for a daily job: pick a step, see the times it makes,
 *  apply. Times already booked stay with their history; the earliest one
 *  anchors the rest, so the job (and this view's URL) keeps its id. */
function Rhythm({ f }: { f: Family }) {
  const nt = useNT()
  const locale = useLocale()
  const current = everyHours(f)
  const [hours, setHours] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anchor = minuteOf(f.events[0])
  const times = hours === null ? null : timesFor(anchor, hours)
  const plan = times && planFor(f, times)

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    const title = titleFor(f)
    const status = f.events.some((e) => e.status === 'active') ? 'active' : 'paused'
    const now = new Date()
    const cal = useCalendar.getState()
    try {
      // New times first: a failure part-way never leaves the job with fewer runs than before.
      await Promise.all(plan.add.map((m) => cal.create(memberAt(f.events[0], m, title(m), status, now))))
      await Promise.all(plan.drop.map((e) => cal.remove(e.id)))
      haptic('success')
      setHours(null)
    } catch (e) {
      haptic('error')
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nx-rows">
      <div className="nx-row">
        <span className="nx-row__text">{nt('routines.repeats')}</span>
        <select
          className="nx-input nx-job__select"
          aria-label={nt('routines.repeats')}
          value={hours ?? current ?? ''}
          disabled={busy}
          onChange={(ev) => {
            const h = Number(ev.target.value)
            setHours(h === current ? null : h)
            setError(null)
          }}
        >
          {current === null && <option value="" disabled>{nt('routines.timesADay', { n: f.events.length })}</option>}
          {HOUR_STEPS.map((h) => <option key={h} value={h}>{rhythm(h, nt)}</option>)}
        </select>
      </div>
      {times && plan && (
        <div className="nx-job__plan">
          <p className="nx-mono">{times.map((m) => timeOfDay(m, locale)).join('  ')}</p>
          <p className="nx-row__hint">{nt('routines.plan', { add: plan.add.length, drop: plan.drop.length })}</p>
          {error && <p className="nx-field__error" role="alert">{error}</p>}
          <div className="nx-job__actions">
            <button type="button" className="nx-btn nx-btn--sm" disabled={busy} onClick={() => setHours(null)}>{nt('common.cancel')}</button>
            <button type="button" className="nx-btn nx-btn--sm nx-btn--primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void apply()}>
              {busy && <Spinner />}{nt('routines.apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function RunNow({ id, onError }: { id: string; onError: (text: string | null) => void }) {
  const nt = useNT()
  const [state, setState] = useState<'idle' | 'busy' | 'ran'>('idle')
  useEffect(() => {
    if (state !== 'ran') return
    const t = window.setTimeout(() => setState('idle'), 2500)
    return () => window.clearTimeout(t)
  }, [state])
  return (
    <button
      type="button"
      className="nx-btn nx-btn--sm nx-btn--outline"
      disabled={state === 'busy'}
      aria-busy={state === 'busy' || undefined}
      onClick={async () => {
        setState('busy')
        onError(null)
        try {
          const r = await useCalendar.getState().runNow(id)
          if (r.status !== 'dispatched') throw new Error(nt('calendar.notStarted', { reason: r.error ? `${r.status}: ${r.error}` : r.status }))
          haptic('success')
          setState('ran')
        } catch (e) {
          haptic('error')
          onError(errText(e))
          setState('idle')
        }
      }}
    >
      {state === 'busy' && <Spinner />}
      {nt(state === 'ran' ? 'routines.started' : 'routines.runNow')}
    </button>
  )
}

/** Long prompts fold to a few lines; counting characters avoids measuring layout. */
const LONG_PROMPT = 160

function JobView({ f }: { f: Family }) {
  const nt = useNT()
  const assignee = useParticipants((s) => (f.events[0].assigneeId ? s.byId[f.events[0].assigneeId] : undefined))
  const next = useMemo(() => nextRun(f.events), [f.events])
  const [full, setFull] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const prompt = f.events[0].agentPrompt
  const long = !!prompt && prompt.length > LONG_PROMPT
  const daily = isDaily(f)
  return (
    <div className="nx-job">
      <div className="nx-job__bar">
        <IconButton small label={nt('routines.back')} onClick={() => goBack(withRoute(getRoute(), { params: { routine: null } }))}>
          <IChevronLeft />
        </IconButton>
        <h3>{f.title || nt('calendar.untitled')}</h3>
        <RunNow id={next?.id ?? f.id} onError={setRunError} />
      </div>
      {runError && <p className="nx-field__error" role="alert">{runError}</p>}
      {assignee && <p className="nx-job__who"><Avatar p={assignee} size={20} presence />{assignee.name}</p>}
      {daily && <Rhythm f={f} />}
      {prompt && (
        <div className="nx-job__prompt">
          <p data-folded={long && !full ? '' : undefined}>{prompt}</p>
          {long && (
            <button type="button" className="nx-btn nx-btn--sm" aria-expanded={full} onClick={() => setFull((v) => !v)}>
              {nt(full ? 'routines.showLess' : 'routines.showAll')}
            </button>
          )}
        </div>
      )}
      <h4 className="nx-group-label">{nt('routines.times')}</h4>
      <div className="nx-rows nx-routine-list">
        {f.events.map((e) => <TimeRow key={e.id} e={e} next={e.id === next?.id} daily={daily} />)}
      </div>
    </div>
  )
}

export function RoutinesTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const route = useRoute()
  const loaded = useCalendar((s) => s.loaded)
  const loading = useCalendar((s) => s.loading)
  const events = useCalendar((s) => s.events)
  useEffect(() => { if (!loaded && !loading) void useCalendar.getState().load() }, [loaded, loading])
  const routines = useMemo(
    () => events.filter((e) => e.kind === 'agent_task' && e.targetConversationId === c.id && e.status !== 'cancelled'),
    [events, c.id],
  )
  const families = useMemo(() => familiesOf(routines), [routines])
  if (!loaded) return <div className="nx-center" aria-busy="true"><Spinner /></div>

  const openId = route.search.get('routine')
  const open = openId ? families.find((f) => f.events.some((e) => e.id === openId)) : undefined
  if (open) return <JobView key={open.id} f={open} />
  // Faces only tell jobs apart when more than one agent runs them.
  const faces = new Set(routines.map((e) => e.assigneeId)).size > 1
  return (
    <div className="nx-routines">
      {families.length === 0
        ? <div className="nx-empty">{nt('routines.none')}</div>
        : <div className="nx-rows nx-routine-list">{families.map((f) => <FamilyRow key={f.id} f={f} face={faces} />)}</div>}
      <a className="nx-btn nx-btn--outline nx-btn--block" href={href({ section: 'calendar' })} onClick={linkClick}>{nt('routines.open')}</a>
    </div>
  )
}
