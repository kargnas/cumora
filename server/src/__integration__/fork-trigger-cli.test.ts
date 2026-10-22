/**
 * `cumora trigger` against a real Postgres (server/src/fork/triggers.ts): an
 * agent makes, sees and deletes triggers only in rooms it is in, for agents in
 * that room, under the Routines tab's rule. A mistake here lets an agent wake
 * someone in a room it cannot see, or remove another room's trigger.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from '../db/pool.js'
import { parseArgs } from '../agents/cli-parse.js'
import { getForkStore } from '../fork/store.js'
import { runTriggerCli } from '../fork/triggers.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

// The server reads the computer's gh profiles relative to its cwd (triggers.ts).
const PROFILE = 'trigger-cli-test'
const PROFILE_DIR = resolve(process.cwd(), 'server/computer/gh', PROFILE)

before(async () => {
  await ensureSchemaOnce()
  mkdirSync(PROFILE_DIR, { recursive: true })
  writeFileSync(resolve(PROFILE_DIR, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n')
})
beforeEach(async () => { await resetAllTables() })
after(async () => {
  rmSync(PROFILE_DIR, { recursive: true, force: true })
  await teardownAll()
})

async function room(companyId: string, id: string, members: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id) VALUES ($1, 'group', $1, $2::jsonb, $3)`,
    [id, JSON.stringify(members), companyId],
  )
}

const cli = (me: string, ...argv: string[]) => runTriggerCli(parseArgs(argv), me)
const create = (me: string, convoId: string, ...flags: string[]) =>
  cli(me, 'create', convoId, 'Install on merge', '--repo', 'kargnas/heliboard', '--profile', PROFILE, '--prompt', 'Install the merged build', ...flags)

test('[integration] an agent makes, sees and deletes triggers only in its own rooms', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'atlas' })
  await seedCompanyWithAgent({ companyId, agentId: 'nova' })
  await seedCompanyWithAgent({ companyId, agentId: 'iris' })
  await room(companyId, 'room-team', ['atlas', 'nova'])
  await room(companyId, 'room-iris', ['iris'])
  const store = await getForkStore()

  assert.match((await create('atlas', 'room-iris')).text, /you are not in room-iris/)
  assert.match((await create('atlas', 'room-team', '--assignee', 'iris')).text, /iris is not an agent in room-team/)
  assert.match((await cli('atlas', 'create', 'room-team', 'x', '--repo', 'a/b', '--profile', 'ghost', '--prompt', 'p')).text, new RegExp(`signed in on the computer: .*${PROFILE}`))
  assert.equal(store.triggers(companyId, 'room-iris').length + store.triggers(companyId, 'room-team').length, 0)

  const made = await create('atlas', 'room-team', '--assignee', 'nova')
  assert.equal(made.ok, true, made.text)
  const [t] = store.triggers(companyId, 'room-team')
  assert.deepEqual(
    { createdBy: t.createdBy, assigneeId: t.assigneeId, repo: t.repo, profile: t.profile, status: t.status },
    { createdBy: 'atlas', assigneeId: 'nova', repo: 'kargnas/heliboard', profile: PROFILE, status: 'active' },
  )

  // Every member of the room sees it; an agent outside the room neither sees nor deletes it.
  assert.match((await cli('nova', 'list')).text, new RegExp(`${t.id} · active · "Install on merge" · kargnas/heliboard as ${PROFILE} · wakes @nova in room-team`))
  assert.equal((await cli('iris', 'list')).text, 'no triggers in your rooms')
  assert.equal((await cli('iris', 'delete', t.id)).ok, false)
  assert.equal(store.triggers(companyId, 'room-team').length, 1)

  assert.equal((await cli('nova', 'delete', t.id)).ok, true)
  assert.equal(store.triggers(companyId, 'room-team').length, 0)
})
