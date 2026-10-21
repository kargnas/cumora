/**
 * Routine families. Calendar repeats at most daily, so an agent that wants a
 * job every few hours books one daily event per time: the PR digest is eight
 * events that differ only in their hour. A family is such a set (same agent,
 * prompt and repeat rule, titles that share a stem), shown as one job.
 * `timesFor` + `planFor` turn "every N hours" back into the events to add and
 * delete, so the schedule changes without hourly support on the server.
 */
import type { CalendarEventInput } from '@/api/client'
import type { CalendarEvent, CalendarEventStatus, Conversation } from '@/types'

/** Whether the event posts into `c`. One booked without a room (an agent's
 *  `calendar create` without `--in`) posts into a 1:1 room holding its creator
 *  and its assignee (`resolveTargetConversation` in server/src/calendar.ts). */
export function postsInto(e: CalendarEvent, c: Pick<Conversation, 'id' | 'kind' | 'members'>): boolean {
  if (e.targetConversationId) return e.targetConversationId === c.id
  return c.kind === 'direct' && c.members.length === 2 && e.assigneeId !== null
    && c.members.includes(e.createdBy) && c.members.includes(e.assigneeId)
}

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
  for (const t of titles) while (!t.startsWith(p)) p = p.slice(0, -1)
  const s = p.replace(/[\s\d:.,·|-]+$/u, '').trim()
  // "Report (KST 4시)" and "Report (KST 7시)" share "Report (KST": drop the
  // bracket the times opened, unless nothing else is left (that would split the job).
  return s.replace(/\s*[([][^)\]]*$/u, '') || s
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
  const m = f.events.map(minuteOf)
  const h = 24 / m.length
  return isDaily(f) && Number.isInteger(h) && timesFor(m[0], h).every((t, i) => t === m[i]) ? h : null
}

/** The times of day for "every `hours` hours" starting at `anchor`. */
export function timesFor(anchor: number, hours: number): number[] {
  return Array.from({ length: 24 / hours }, (_, k) => (anchor + k * hours * 60) % 1440).sort((a, b) => a - b)
}

/** Members already at a wanted time stay (with their run history); the rest
 *  are dropped, and the wanted times nobody covers are added. */
export function planFor(f: Family, times: number[]): { drop: CalendarEvent[]; add: number[] } {
  const want = new Set(times)
  const drop = f.events.filter((e) => !want.delete(minuteOf(e)))
  return { drop, add: [...want] }
}

/** Titles for new times. When every member names its own time the same way
 *  ("PR digest check 18:07 KST"), a new one follows suit; otherwise it gets
 *  the family title. */
export function titleFor(f: Family): (minute: number) => string {
  const frames = new Set(f.events.map((e) => e.title.replace(hhmm(minuteOf(e)), '\0')))
  const [frame] = frames
  return (m) => (frames.size === 1 && frame.includes('\0') ? frame.replace('\0', hhmm(m)) : f.title)
}

/** A copy of `t` at another time of day. It starts at the next such time
 *  after `now`, because the scheduler fires a start that is already past. */
export function memberAt(t: CalendarEvent, minute: number, title: string, status: CalendarEventStatus, now: Date): CalendarEventInput {
  const start = new Date(now)
  start.setHours(0, minute, 0, 0)
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
