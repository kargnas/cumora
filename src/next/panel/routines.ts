/**
 * Routine families. Calendar repeats at most daily, so an agent that wants a
 * job every few hours books one daily event per time: the PR digest is eight
 * events that differ only in their hour. A family is such a set (same agent,
 * prompt and repeat rule, titles that share a stem), shown as one job.
 * `timesFor` + `planFor` turn "every N hours" back into the events to keep,
 * add and delete, so the schedule changes without hourly support on the server.
 */
import type { CalendarEventInput } from '@/api/client'
import type { CalendarEvent, CalendarEventStatus } from '@/types'

/** Steps that split a day evenly, so every day runs the same times. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24] as const

export interface Family {
  /** The earliest member's id. `timesFor` always keeps that time, so the id survives a change. */
  id: string
  title: string
  /** Members by local time of day. */
  events: CalendarEvent[]
}

/** Minutes after local midnight at which the event fires. */
export function minuteOf(e: CalendarEvent): number {
  const d = new Date(e.startAt)
  return d.getHours() * 60 + d.getMinutes()
}

export function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

export function isDaily(f: Family): boolean {
  const r = f.events[0].recurrence
  return r?.freq === 'daily' && r.interval === 1
}

/** "PR digest check 18:07 KST" and "PR digest check 21:07 KST" → "PR digest check". */
function stem(titles: string[]): string {
  let p = titles[0]
  for (const t of titles) {
    let i = 0
    while (i < p.length && i < t.length && p[i] === t[i]) i++
    p = p.slice(0, i)
  }
  return p.replace(/[\s\d:.,·|-]+$/u, '').trim()
}

export function familiesOf(events: CalendarEvent[]): Family[] {
  const groups = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    const r = e.recurrence
    // A one-shot event has no rhythm to share with anything.
    const key = r ? JSON.stringify([e.assigneeId, e.agentPrompt, r.freq, r.interval, [...(r.byweekday ?? [])].sort(), e.allDay]) : e.id
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const out: Family[] = []
  for (const members of groups.values()) {
    const title = stem(members.map((e) => e.title))
    // The same prompt under unrelated titles is separate jobs that share text.
    const sets = members.length > 1 && !title ? members.map((e) => [e]) : [members]
    for (const set of sets) {
      const events = [...set].sort((a, b) => minuteOf(a) - minuteOf(b))
      out.push({ id: events[0].id, title: set.length > 1 ? title : set[0].title, events })
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

/** Hours between runs when a daily family's times split the day evenly, else null. */
export function everyHours(f: Family): number | null {
  if (!isDaily(f)) return null
  const m = f.events.map(minuteOf)
  const n = m.length
  const gap = 1440 / n
  if (!Number.isInteger(gap) || gap % 60 !== 0) return null
  // Each time sits one gap after the one before it; the first wraps from the last.
  return m.every((v, i) => (i === 0 ? m[n - 1] - 1440 : m[i - 1]) + gap === v) ? gap / 60 : null
}

/** The times of day for "every `hours` hours" starting at `anchor`. */
export function timesFor(anchor: number, hours: number): number[] {
  return Array.from({ length: 24 / hours }, (_, k) => (anchor + k * hours * 60) % 1440).sort((a, b) => a - b)
}

export interface Plan {
  keep: CalendarEvent[]
  drop: CalendarEvent[]
  add: number[]
}

/** Members already at a wanted time stay (with their run history); the rest go, and the missing times are added. */
export function planFor(f: Family, times: number[]): Plan {
  const want = new Set(times)
  const keep: CalendarEvent[] = []
  const drop: CalendarEvent[] = []
  for (const e of f.events) {
    const m = minuteOf(e)
    if (want.delete(m)) keep.push(e)
    else drop.push(e)
  }
  return { keep, drop, add: [...want] }
}

/** Titles for new times. When every member names its own time the same way
 *  ("PR digest check 18:07 KST"), a new one follows suit; otherwise it gets
 *  the family title. */
export function titleFor(f: Family): (minute: number) => string {
  let frame: [string, string] | null | undefined
  for (const e of f.events) {
    const t = hhmm(minuteOf(e))
    const i = e.title.indexOf(t)
    const cur: [string, string] | null = i < 0 ? null : [e.title.slice(0, i), e.title.slice(i + t.length)]
    frame = frame === undefined || (frame && cur && frame[0] === cur[0] && frame[1] === cur[1]) ? cur : null
    if (!frame) break
  }
  return (m) => (frame ? `${frame[0]}${hhmm(m)}${frame[1]}` : f.title)
}

/** A copy of `t` at another time of day. It starts at the next such time
 *  after `now`, because the scheduler fires a start that is already past. */
export function memberAt(t: CalendarEvent, minute: number, title: string, status: CalendarEventStatus, now: Date): CalendarEventInput {
  const start = new Date(now)
  start.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1)
  const span = t.endAt ? Date.parse(t.endAt) - Date.parse(t.startAt) : null
  return {
    title,
    kind: t.kind,
    description: t.description,
    assigneeId: t.assigneeId,
    targetConversationId: t.targetConversationId,
    agentPrompt: t.agentPrompt,
    startAt: start.toISOString(),
    endAt: span === null ? null : new Date(start.getTime() + span).toISOString(),
    allDay: t.allDay,
    recurrence: t.recurrence,
    status,
    reminderMinutesBefore: t.reminderMinutesBefore,
    reminderChannel: t.reminderChannel,
    isPrivate: t.isPrivate,
  }
}
