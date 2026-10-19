/**
 * DELETE /api/fork/agents/:id against a real Postgres (server/src/fork/purge.ts):
 * only an off-boarded agent goes; its 1:1 room and what it owned go with it;
 * what it wrote in a room that stays keeps its place under a deleted author;
 * its id is never given out again; and its computer is told to remove its
 * files.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { pool } from '../db/pool.js'
import { createAgentRecord } from '../agents/create.js'
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

async function message(companyId: string, id: string, conversationId: string, authorId: string, sequence: number, attachment: unknown = null): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id, attachment)
     VALUES ($1, $2, $3, 'text', $1, $4, $5, $6::jsonb)`,
    [id, conversationId, authorId, sequence, companyId, attachment === null ? null : JSON.stringify(attachment)],
  )
}

async function computer(companyId: string, id: string, kind: 'local' | 'cloud'): Promise<void> {
  await pool.query(`INSERT INTO computers (id, company_id, name, kind) VALUES ($1, $2, $1, $3)`, [id, companyId, kind])
}

const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n)

test('[integration] deleting an off-boarded agent removes it and keeps what it wrote in rooms that stay', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'atlas' })
  await seedCompanyWithAgent({ companyId, agentId: 'nova' })
  await seedUserMembership(USER_ID, companyId)
  await computer(companyId, 'computer-1', 'local')
  await pool.query(`UPDATE participants SET computer_id = 'computer-1' WHERE id = 'atlas'`)
  await room(companyId, 'dm-atlas', 'direct', [USER_ID, 'atlas'])
  await room(companyId, 'dm-nova', 'direct', [USER_ID, 'nova'])
  await room(companyId, 'team', 'group', [USER_ID, 'atlas', 'nova'])
  // One upload of the 1:1 room was shared into #team by URL alone, as an
  // agent's `cumora send --attach <url>` does; the other was not.
  await message(companyId, 'm-dm', 'dm-atlas', 'atlas', 1, { key: 'attachments/shared.png', url: '/uploads/attachments/shared.png', name: 'shared.png' })
  await message(companyId, 'm-dm-own', 'dm-atlas', USER_ID, 2, [{ key: 'attachments/own.png', url: '/uploads/attachments/own.png', name: 'own.png' }])
  await message(companyId, 'm-team-atlas', 'team', 'atlas', 1, { url: '/uploads/attachments/shared.png', name: 'shared.png' })
  await message(companyId, 'm-team-me', 'team', USER_ID, 2)
  await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ('m-team-me', 'atlas', '👍')`)
  await pool.query(
    `INSERT INTO agent_memory (id, agent_id, kind, body, company_id) VALUES ('mem-1', 'atlas', 'note', 'x', $1), ('mem-2', 'nova', 'note', 'y', $1)`,
    [companyId],
  )
  await pool.query(`INSERT INTO agent_log (id, agent_id, kind, body, company_id) VALUES ('log-1', 'atlas', 'note', 'x', $1)`, [companyId])
  await pool.query(`INSERT INTO llm_calls (id, company_id, agent_id, purpose, model) VALUES ('call-1', $1, 'atlas', 'turn', 'm')`, [companyId])
  await pool.query(`INSERT INTO agent_triages (id, agent_id, company_id, source) VALUES ('triage-1', 'atlas', $1, 'byoa-claude')`, [companyId])

  // An agent on the team cannot be deleted: off-boarding comes first.
  assert.equal((await request(companyId, '/fork/agents/atlas', 'DELETE')).status, 409)
  assert.equal((await request(companyId, '/agents/atlas', 'DELETE')).status, 200)
  const res = await request(companyId, '/fork/agents/atlas', 'DELETE')
  assert.equal(res.status, 200, await res.text())

  assert.equal(await count(`SELECT COUNT(*) AS n FROM participants WHERE id = 'atlas'`), 0)
  assert.deepEqual((await pool.query(`SELECT id FROM conversations ORDER BY id`)).rows.map((r) => r.id), ['dm-nova', 'team'])
  assert.equal(await count(`SELECT COUNT(*) AS n FROM messages WHERE id = 'm-dm'`), 0)
  assert.deepEqual((await pool.query(`SELECT members FROM conversations WHERE id = 'team'`)).rows[0].members, [USER_ID, 'nova'])

  const { rows: [kept] } = await pool.query<{ author_id: string }>(`SELECT author_id FROM messages WHERE id = 'm-team-atlas'`)
  assert.match(kept.author_id, /^deleted:[0-9a-f]{8}$/)
  const ids = async (sql: string) => (await pool.query<{ id: string }>(sql)).rows.map((r) => r.id)
  assert.deepEqual(await ids(`SELECT user_id AS id FROM message_reactions WHERE message_id = 'm-team-me'`), [kept.author_id])
  assert.deepEqual(await ids(`SELECT agent_id AS id FROM llm_calls WHERE id = 'call-1'`), [kept.author_id])
  assert.deepEqual(await ids(`SELECT agent_id AS id FROM agent_triages WHERE id = 'triage-1'`), [kept.author_id])
  assert.deepEqual(await ids(`SELECT agent_id AS id FROM agent_memory ORDER BY id`), ['nova'])
  assert.equal(await count(`SELECT COUNT(*) AS n FROM agent_log WHERE agent_id = 'atlas'`), 0)

  // Only the upload no room still shows is queued for deletion.
  const { rows: jobs } = await pool.query<{ storage_keys: string[] }>(`SELECT storage_keys FROM workspace_cleanup_jobs`)
  assert.deepEqual(jobs.flatMap((j) => j.storage_keys), ['attachments/own.png'])
  assert.ok((await getForkStore()).computerPurges('computer-1').includes('atlas'))

  // Gone means gone: a second delete finds nothing, and an agent hired under
  // the same name gets another id.
  assert.equal((await request(companyId, '/fork/agents/atlas', 'DELETE')).status, 404)
  const rehired = await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 20, name: 'Atlas', systemPrompt: 'x' })
  assert.match(rehired.id, /^atlas-[a-z0-9]{4}$/)
  ;(await getForkStore()).clearComputerPurge('computer-1', 'atlas')
})

test('[integration] a cloud agent leaves no queue row, and a queue row whose COMMIT failed is not handed to its computer', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'orbit' })
  await seedCompanyWithAgent({ companyId, agentId: 'pulse' })
  await seedUserMembership(USER_ID, companyId)
  await computer(companyId, 'cloud-1', 'cloud')
  await pool.query(`UPDATE participants SET computer_id = 'cloud-1', departed_at = NOW() WHERE id = 'orbit'`)
  const res = await request(companyId, '/fork/agents/orbit', 'DELETE')
  assert.equal(res.status, 200, await res.text())
  const store = await getForkStore()
  assert.deepEqual(store.computerPurges('cloud-1'), [])
  assert.ok(store.purgedAgents().has('orbit'))

  // `pulse` is queued but still in participants, as after a failed COMMIT.
  store.purgeAgent(companyId, 'pulse', [], 'computer-2')
  const { computerPurges } = await import('../fork/purge.js')
  assert.deepEqual(await computerPurges('computer-2'), [])
  await pool.query(`DELETE FROM participants WHERE id = 'pulse'`)
  assert.deepEqual(await computerPurges('computer-2'), ['pulse'])
  store.clearComputerPurge('computer-2', 'pulse')
})
