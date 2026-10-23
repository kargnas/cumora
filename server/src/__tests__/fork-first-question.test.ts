/**
 * The wake a new agent gets in its first room (fork/firstQuestion.ts). It
 * reaches the agent only through the alarm gates, which key on the envelope's
 * kind and assignee: a wrong field there wakes nobody, or another agent. The
 * brief is all the agent reads of it, in a wake digest line the daemon cuts at
 * 600 characters, so it must say who hired the agent and which room the
 * question goes to, and fit that line.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstQuestionEnvelope, type Person } from '../fork/firstQuestion.js'
import { buildTriageRequest } from '../agents/triage-core.js'
import type { InboxRow } from '../agents/runtime/client.js'

const agent: Person = { id: 'sand-castle-ayh0', name: 'Sand Castle' }
const owner: Person = { id: 'u-c0b5da52-6de', name: 'Sangrak Choi' }
const room = 'direct-1d21cc6e-339'
const body = firstQuestionEnvelope(agent, owner, room)

function verdict(agentId: string) {
  const row = { id: 'm-1', conversation_id: room, kind: 'system', author_id: 'calendar', author_kind: null, body } as unknown as InboxRow
  const persona = { id: agentId, name: agentId, role: '', style: '', model: null, companyId: 'co-1' }
  return buildTriageRequest({ agentId, persona, inbox: [row], context: [] }).verdict
}

test('the new agent wakes on it, and no other agent does', () => {
  assert.equal(verdict('sand-castle-ayh0')?.source, 'calendar-due')
  assert.equal(verdict('pr-babysitter-lq5q')?.actionable, false)
})

test('the brief says who hired the agent and where to ask, within the digest line', () => {
  const { title, agentPrompt } = JSON.parse(body) as { title: string; agentPrompt: string }
  for (const part of ['Sangrak Choi (@u-c0b5da52-6de) just hired you.', `cumora ask ${room} `]) {
    assert.ok(agentPrompt.includes(part), `the brief lacks "${part}"`)
  }
  // The line the daemon renders for a due alarm (snapshotUnread in agents/computer/daemon.ts).
  assert.ok(`[calendar:due] ${title} — ${agentPrompt}`.length <= 600)
})
