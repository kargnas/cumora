/**
 * Routine families (src/next/panel/routines.ts). The mistakes worth catching:
 * the eight PR digest events not folding into one job, unrelated routines
 * that share a prompt folding together, an "every N hours" change that
 * deletes a time it keeps or loses the anchor the URL points at, and a new
 * member that starts in the past (the scheduler would fire it at once).
 * Dates are built in local time, so the checks hold in any timezone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CalendarEvent } from '../src/types'
import { everyHours, familiesOf, hhmm, memberAt, minuteOf, planFor, timesFor, titleFor } from '../src/next/panel/routines.ts'

const PROMPT = 'PR digest check. ALL config is in workspace/state/digest.json.'
const daily = { freq: 'daily', interval: 1 } as const

function ev(id: string, title: string, hour: number, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, companyId: 'co', createdBy: 'pr-summary-bot', kind: 'agent_task', title, description: null,
    assigneeId: 'pr-summary-bot', targetConversationId: 'direct-1', agentPrompt: PROMPT,
    startAt: new Date(2026, 9, 18, hour, 7).toISOString(), endAt: null, allDay: false,
    recurrence: daily, status: 'active', lastFiredAt: null, reminderMinutesBefore: null,
    reminderChannel: null, isPrivate: false, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
    ...over,
  }
}

// The PR Summary Bot DM as it was on 2026-10-19: eight digests three hours apart, created out of order, plus a weekly summary.
const digests = [18, 21, 0, 3, 6, 9, 12, 15].map((h) => ev(`d${h}`, `PR digest check ${hhmm(h * 60 + 7)} KST`, h))
const weekly = ev('w', 'PR weekly summary Mon 09:00 KST', 9, { agentPrompt: 'Weekly summary.', recurrence: { freq: 'weekly', interval: 1, byweekday: [0] } })

test('the eight digest events fold into one job every 3 hours, the weekly summary stays its own', () => {
  const fams = familiesOf([...digests, weekly])
  assert.deepEqual(fams.map((f) => [f.title, f.events.length]), [['PR digest check', 8], ['PR weekly summary Mon 09:00 KST', 1]])
  const digest = fams[0]
  assert.equal(digest.id, 'd0', 'the anchor is the earliest time of day')
  assert.deepEqual(digest.events.map((e) => hhmm(minuteOf(e))), ['00:07', '03:07', '06:07', '09:07', '12:07', '15:07', '18:07', '21:07'])
  assert.equal(everyHours(digest), 3)
  assert.equal(everyHours(fams[1]), null, 'weekly rules have no hour spacing')
})

test('routines that only share a prompt stay apart', () => {
  const fams = familiesOf([ev('a', 'Morning brief', 9), ev('b', 'Evening brief', 18)])
  assert.equal(fams.length, 2)
})

test('uneven or doubled times are not an hour rhythm', () => {
  assert.equal(everyHours(familiesOf([ev('a', 'Job 01:07', 1), ev('b', 'Job 05:07', 5)])[0]), null)
  assert.equal(everyHours(familiesOf([ev('a', 'Job', 1), ev('b', 'Job', 1)])[0]), null)
  assert.equal(everyHours(familiesOf([ev('a', 'Job 09:07', 9)])[0]), 24)
})

test('every 4 hours keeps the shared times and the anchor, adds the rest, drops the others', () => {
  const digest = familiesOf(digests)[0]
  const plan = planFor(digest, timesFor(minuteOf(digest.events[0]), 4))
  // d0 (the anchor the URL names) and d12 sit on the new rhythm, so they stay.
  assert.deepEqual(plan.drop.map((e) => e.id).sort(), ['d15', 'd18', 'd21', 'd3', 'd6', 'd9'])
  assert.deepEqual(plan.add.map(hhmm), ['04:07', '08:07', '16:07', '20:07'])
})

test('new members follow the naming of the old ones, or take the family title', () => {
  const digest = familiesOf(digests)[0]
  assert.equal(titleFor(digest)(4 * 60 + 7), 'PR digest check 04:07 KST')
  const mixed = familiesOf([ev('a', 'Digest 00:07', 0), ev('b', 'Digest run 12:07', 12)])[0]
  assert.equal(titleFor(mixed)(6 * 60 + 7), 'Digest')
})

test('a new member never starts in the past', () => {
  const now = new Date(2026, 9, 19, 2, 20)
  const early = memberAt(digests[2], 0 * 60 + 7, 'x', 'active', now)
  const later = memberAt(digests[2], 4 * 60 + 7, 'x', 'paused', now)
  assert.equal(early.startAt, new Date(2026, 9, 20, 0, 7).toISOString(), '00:07 already passed today')
  assert.equal(later.startAt, new Date(2026, 9, 19, 4, 7).toISOString())
  assert.equal(later.status, 'paused')
  assert.deepEqual([later.agentPrompt, later.assigneeId, later.recurrence], [PROMPT, 'pr-summary-bot', daily])
})
