/**
 * DELETE /api/fork/agents/:id against a real Postgres (server/src/fork/purge.ts):
 * only an off-boarded agent goes; its 1:1 room and what it owned go with it;
 * what it wrote in a room that stays keeps its place under a deleted author,
 * so an agent hired later under the same id does not inherit it; and its
 * computer is told to remove its files.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { pool } from '../db/pool.js'
import { getForkStore } from '../fork/store.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

const USER_ID = 'u-purge-owner'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll(server) })

const request = (companyId: string, path: string, method = 'GET') =>
  fetch(`${baseUrl}/api${path}`, { method, headers: { 'x-company-id': companyId } })

async function room(companyId: string, id: string, kind: 'direct' | 'group', members: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id) VALUES ($1, $2, $1, $3::jsonb, $4)`,
    [id, kind, JSON.stringify(members), companyId],
  )
}

async function message(companyId: string, id: string, conversationId: string, authorId: string, sequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1, $2, $3, 'text', $1, $4, $5)`,
    [id, conversationId, authorId, sequence, companyId],
  )
}

test('[integration] deleting an off-boarded agent removes it and keeps what it wrote in rooms that stay', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'atlas' })
  await seedCompanyWithAgent({ companyId, agentId: 'nova' })
  await seedUserMembership(USER_ID, companyId)
  await pool.query(`UPDATE participants SET computer_id = 'computer-1' WHERE id = 'atlas'`)
  await room(companyId, 'dm-atlas', 'direct', [USER_ID, 'atlas'])
  await room(companyId, 'dm-nova', 'direct', [USER_ID, 'nova'])
  await room(companyId, 'team', 'group', [USER_ID, 'atlas', 'nova'])
  await message(companyId, 'm-dm', 'dm-atlas', 'atlas', 1)
  await message(companyId, 'm-team-atlas', 'team', 'atlas', 1)
  await message(companyId, 'm-team-me', 'team', USER_ID, 2)
  await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ('m-team-me', 'atlas', '👍')`)
  await pool.query(
    `INSERT INTO agent_memory (id, agent_id, kind, body, company_id) VALUES ('mem-1', 'atlas', 'note', 'x', $1), ('mem-2', 'nova', 'note', 'y', $1)`,
    [companyId],
  )
  await pool.query(`INSERT INTO agent_log (id, agent_id, kind, body, company_id) VALUES ('log-1', 'atlas', 'note', 'x', $1)`, [companyId])
  await pool.query(`INSERT INTO llm_calls (id, company_id, agent_id, purpose, model) VALUES ('call-1', $1, 'atlas', 'turn', 'm')`, [companyId])

  // An agent on the team cannot be deleted: off-boarding comes first.
  assert.equal((await request(companyId, '/fork/agents/atlas', 'DELETE')).status, 409)
  assert.equal((await request(companyId, '/agents/atlas', 'DELETE')).status, 200)
  const res = await request(companyId, '/fork/agents/atlas', 'DELETE')
  assert.equal(res.status, 200, await res.text())

  const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n)
  assert.equal(await count(`SELECT COUNT(*) AS n FROM participants WHERE id = 'atlas'`), 0)
  assert.deepEqual((await pool.query(`SELECT id FROM conversations ORDER BY id`)).rows.map((r) => r.id), ['dm-nova', 'team'])
  assert.equal(await count(`SELECT COUNT(*) AS n FROM messages WHERE id = 'm-dm'`), 0)
  assert.deepEqual((await pool.query(`SELECT members FROM conversations WHERE id = 'team'`)).rows[0].members, [USER_ID, 'nova'])

  const { rows: [kept] } = await pool.query<{ author_id: string }>(`SELECT author_id FROM messages WHERE id = 'm-team-atlas'`)
  assert.match(kept.author_id, /^deleted:[0-9a-f]{8}$/)
  const sameAuthor = async (sql: string) => (await pool.query<{ id: string }>(sql)).rows.map((r) => r.id)
  assert.deepEqual(await sameAuthor(`SELECT user_id AS id FROM message_reactions WHERE message_id = 'm-team-me'`), [kept.author_id])
  assert.deepEqual(await sameAuthor(`SELECT agent_id AS id FROM llm_calls WHERE id = 'call-1'`), [kept.author_id])
  assert.deepEqual(await sameAuthor(`SELECT agent_id AS id FROM agent_memory ORDER BY id`), ['nova'])
  assert.equal(await count(`SELECT COUNT(*) AS n FROM agent_log WHERE agent_id = 'atlas'`), 0)
  assert.ok((await getForkStore()).computerPurges('computer-1').includes('atlas'))

  // Gone means gone: a second delete finds nothing.
  assert.equal((await request(companyId, '/fork/agents/atlas', 'DELETE')).status, 404)
  ;(await getForkStore()).clearComputerPurge('computer-1', 'atlas')
})
