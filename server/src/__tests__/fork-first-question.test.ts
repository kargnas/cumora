/**
 * The wake a new agent gets in its first room (fork/firstQuestion.ts). It
 * reaches the agent only through the alarm gates, which key on the envelope's
 * kind and assignee: a wrong field there wakes nobody, or another agent. The
 * daemon's wake digest cuts the alarm line at 600 characters, so what the agent
 * must do comes first; long names would otherwise push it past the cut.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakeBody } from '../fork/dispatch.js'
import { firstQuestionWake, type Person } from '../fork/firstQuestion.js'
import { buildTriageRequest } from '../agents/triage-core.js'
import type { InboxRow } from '../agents/runtime/client.js'

const room = 'direct-1d21cc6e-339'

function verdict(body: string, agentId: string) {
  const row = { id: 'm-1', conversation_id: room, kind: 'system', author_id: 'calendar', author_kind: null, body } as unknown as InboxRow
  const persona = { id: agentId, name: agentId, role: '', style: '', model: null, companyId: 'co-1' }
  return buildTriageRequest({ agentId, persona, inbox: [row], context: [] }).verdict
}

test('the new agent wakes on it, and no other agent does', () => {
  const body = wakeBody(firstQuestionWake('co-1', { id: 'sand-castle-ayh0', name: 'Sand Castle' }, { id: 'u-1', name: 'Sangrak Choi' }, room))
  assert.equal(verdict(body, 'sand-castle-ayh0')?.source, 'calendar-due')
  assert.equal(verdict(body, 'pr-babysitter-lq5q')?.actionable, false)
})

test('what the agent must do survives the digest cut, even with long names', () => {
  const agent: Person = { id: 'a'.repeat(24), name: 'Autopilot Rule Keeper for every OP.GG repository we own' }
  const owner: Person = { id: 'u-c0b5da52-6de', name: 'Sangrak Choi (최상락), Head of Engineering' }
  const { title, agentPrompt } = firstQuestionWake('co-1', agent, owner, room)
  // The line the daemon renders for a due alarm (snapshotUnread in agents/computer/daemon.ts).
  const line = `[calendar:due] ${title} — ${agentPrompt}`.slice(0, 600)
  for (const part of [`(@${owner.id}) just hired you`, 'one question card and nothing else', `cumora ask ${room} `, ' once.']) {
    assert.ok(line.includes(part), `the cut line lacks "${part}"`)
  }
})
