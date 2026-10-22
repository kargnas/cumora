/**
 * Who reads a room's developer token figures, and which calls they get
 * (server/src/fork/tokens.ts), against a real Postgres. The mistakes worth
 * catching: a person outside the room or without the owner or admin role
 * reading them, rows the daemon did not mark counting, and an agenda turn
 * (which can carry another room's work) landing anywhere but its agent's 1:1
 * room.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { MAX_ROWS, readRoomTokens, TokenAccessError } from '../fork/tokens.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function room(companyId: string, id: string, kind: 'direct' | 'group', members: string[]): Promise<void> {
  await pool.query(`INSERT INTO conversations (id, company_id, kind, title, members) VALUES ($1, $2, $3, $1, $4::jsonb)`, [id, companyId, kind, JSON.stringify(members)])
  for (const [i, member] of members.entries()) {
    await pool.query(`INSERT INTO conversation_members (conversation_id, company_id, participant_id, ordinal) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, companyId, member, i])
  }
}

async function call(companyId: string, agentId: string, room: string | null, extras: Record<string, unknown> | null, at = '2026-10-22T10:00:00Z'): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO llm_calls (id, company_id, agent_id, conversation_id, purpose, model, input_tokens, created_at, extras)
     VALUES ($1, $2, $3, $4, 'agent-turn', 'm', 1, $5, $6)`,
    [id, companyId, agentId, room, at, extras && JSON.stringify(extras)],
  )
  return id
}

const SINCE = new Date('2026-10-22T00:00:00Z')

test('only owners and admins in the room read it, and only rows the daemon marked count', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await seedUserMembership('u-admin', companyId)
  await seedUserMembership('u-member', companyId)
  await seedUserMembership('u-outside', companyId)
  await pool.query(`UPDATE company_members SET role = 'member' WHERE user_id = 'u-member'`)
  await room(companyId, 'dm', 'direct', [agentId, 'u-admin', 'u-member'])
  await room(companyId, 'grp', 'group', [agentId, 'u-admin', 'u-member'])

  await call(companyId, agentId, 'dm', { acct: 2 })
  await call(companyId, agentId, 'dm', null)
  await call(companyId, agentId, 'dm', { acct: 1 })
  await call(companyId, agentId, 'dm', { acct: 2 }, '2026-10-21T23:59:59Z')
  await call(companyId, agentId, 'dm', { acct: 2, rest: { subs: [{ id: 't1', description: 'use sk-abcdefghijklmnopqrstuvwx', type: 'general', tokens: 9, toolUses: 1, durationMs: 1 }] } })
  await call(companyId, agentId, 'grp', { acct: 2 })
  await call(companyId, agentId, null, { acct: 2, agenda: true })
  // A wake that landed during an agenda turn names a room; the turn is still no room's.
  await call(companyId, agentId, 'grp', { acct: 2, agenda: true })

  await assert.rejects(readRoomTokens(companyId, 'u-outside', 'dm', SINCE), (e: unknown) => e instanceof TokenAccessError && e.status === 404)
  await assert.rejects(readRoomTokens(companyId, 'u-member', 'dm', SINCE), (e: unknown) => e instanceof TokenAccessError && e.status === 403)

  const dm = await readRoomTokens(companyId, 'u-admin', 'dm', SINCE)
  assert.equal(dm.calls.length, 2, 'unmarked, older-mark and pre-since rows stay out')
  assert.equal(dm.agenda.length, 2, "the agent's 1:1 room shows its agenda turns")
  assert.doesNotMatch(dm.calls[1].rest?.subs[0].description ?? '', /sk-abcdef/, 'a subagent description is redacted')
  assert.equal(dm.cut, null)

  const grp = await readRoomTokens(companyId, 'u-admin', 'grp', SINCE)
  assert.equal(grp.calls.length, 1, 'an agenda row never counts in a room')
  assert.equal(grp.agenda.length, 0, 'a group room shows no agenda turns')
})

test('an answer cut at MAX_ROWS keeps the newest rows and says where it was cut', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await seedUserMembership('u-admin', companyId)
  await room(companyId, 'dm', 'direct', [agentId, 'u-admin'])
  await pool.query(
    `INSERT INTO llm_calls (id, company_id, agent_id, conversation_id, purpose, model, input_tokens, created_at, extras)
     SELECT 'g-' || i, $1, $2, 'dm', 'agent-turn', 'm', 1, '2026-10-22T10:00:00Z'::timestamptz + i * interval '1 second', '{"acct": 2}'::jsonb
       FROM generate_series(1, $3::int + 1) AS i`,
    [companyId, agentId, MAX_ROWS],
  )
  const dm = await readRoomTokens(companyId, 'u-admin', 'dm', SINCE)
  assert.equal(dm.calls.length, MAX_ROWS)
  assert.equal(dm.calls[0].at, '2026-10-22T10:00:02.000Z', 'the oldest row is the one dropped')
  assert.equal(dm.cut, '2026-10-22T10:00:02.000Z')
})
