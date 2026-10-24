/**
 * A new agent's first question through POST /api/agents (fork/firstQuestion.ts):
 * the hire wakes the agent once in its new 1:1 room, and a retry with the same
 * requestId, which finds the agent it already made, wakes it no second time.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'

const OWNER = 'u-first-question'
const COMPANY = 'co-first-question'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  await resetAllTables()
  await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Sangrak Choi')`, [OWNER, `${OWNER}@test.local`])
  await pool.query(`INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $1, $1, $2)`, [COMPANY, OWNER])
  await pool.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [COMPANY, OWNER])
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', 'Sangrak Choi', 'S', '#abcdef', 'avail')`,
    [OWNER, COMPANY],
  )
  const app = await buildApiTestApp(OWNER)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

after(async () => {
  await teardownAll(server)
})

test('[integration] a hire wakes the new agent once in its 1:1 room, and a retry does not', async () => {
  const hire = () => fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify({
      requestId: 'first-question-hire',
      name: 'Changelog Test',
      role: 'Changelog writer',
      systemPrompt: 'Writes changelogs from merged pull requests.',
    }),
  })
  const first = await hire()
  assert.equal(first.status, 201)
  const { id } = await first.json() as { id: string }
  assert.equal((await hire()).status, 200)

  const { rows } = await pool.query<{ body: string; members: string[] }>(
    `SELECT m.body,
            ARRAY(SELECT participant_id FROM conversation_members WHERE conversation_id = c.id ORDER BY participant_id) AS members
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.company_id = $1 AND m.author_id = 'calendar'`,
    [COMPANY],
  )
  assert.equal(rows.length, 1)
  const wake = JSON.parse(rows[0].body) as { eventKind: string; assigneeId: string }
  assert.deepEqual([wake.eventKind, wake.assigneeId], ['hired', id])
  assert.deepEqual(rows[0].members, [OWNER, id].sort())
})
