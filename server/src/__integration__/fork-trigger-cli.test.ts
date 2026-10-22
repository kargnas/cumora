/**
 * `cumora trigger` against a real Postgres (server/src/fork/triggers.ts): an
 * agent makes, sees and deletes triggers only in rooms it is in, for agents in
 * that room, under the Routines tab's rule, and a room or trigger it cannot see
 * answers like one that does not exist. A mistake here lets an agent wake
 * someone in a room it cannot see, remove another room's trigger, or learn
 * which rooms and triggers exist.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../db/pool.js'
import { parseArgs } from '../agents/cli-parse.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

// The fork store and the gh profiles resolve from the server's cwd when their
// modules load, so this test runs them in a directory of its own.
const home = process.cwd()
// Real path: on macOS the cwd reads /private/var/... for a tmpdir() under /var.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fork-trigger-cli-')))
process.chdir(dir)
const { getForkStore } = await import('../fork/store.js')
const { GH_DIR, runTriggerCli } = await import('../fork/triggers.js')

const PROFILE = 'trigger-cli-test'

before(async () => {
  assert.ok(GH_DIR.startsWith(dir), 'the gh profiles must come from the test directory')
  await ensureSchemaOnce()
  mkdirSync(join(GH_DIR, PROFILE), { recursive: true })
  writeFileSync(join(GH_DIR, PROFILE, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n')
})
beforeEach(async () => { await resetAllTables() })
after(async () => {
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
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
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ('u-owner', $1, 'human', 'Owner', 'owner', 'O', '#abcdef', 'avail')`,
    [companyId],
  )
  await room(companyId, 'room-team', ['u-owner', 'atlas', 'nova'])
  await room(companyId, 'room-iris', ['iris'])
  const store = await getForkStore()
  const count = () => store.triggers(companyId, 'room-team').length + store.triggers(companyId, 'room-iris').length

  // A room the agent is not in reads like a room that does not exist.
  const outside = await create('atlas', 'room-iris')
  assert.match(outside.text, /you are not in room-iris/)
  assert.equal(outside.text.replace('room-iris', '<room>'), (await create('atlas', 'room-gone')).text.replace('room-gone', '<room>'))
  // Only an agent of the room is woken, and a bare --assignee is not "me".
  assert.match((await create('atlas', 'room-team', '--assignee', 'iris')).text, /iris is not an agent in room-team/)
  assert.match((await create('atlas', 'room-team', '--assignee', 'u-owner')).text, /u-owner is not an agent in room-team/)
  assert.match((await create('atlas', 'room-team', '--assignee')).text, /^usage: /)
  assert.equal(count(), 0)

  assert.equal((await create('atlas', 'room-team')).ok, true)
  assert.equal(store.triggers(companyId, 'room-team')[0].assigneeId, 'atlas', 'the assignee defaults to the caller')
  const made = await create('atlas', 'room-team', '--assignee', 'nova')
  assert.equal(made.ok, true, made.text)
  const t = store.triggers(companyId, 'room-team').find((x) => x.assigneeId === 'nova')
  assert.ok(t)
  assert.deepEqual(
    { createdBy: t.createdBy, repo: t.repo, profile: t.profile, status: t.status },
    { createdBy: 'atlas', repo: 'kargnas/heliboard', profile: PROFILE, status: 'active' },
  )

  // Every agent of the room sees it; one outside the room neither sees it nor
  // learns that it exists.
  assert.match((await cli('nova', 'list')).text, new RegExp(`${t.id} · active · "Install on merge" · kargnas/heliboard as ${PROFILE} · wakes @nova in room-team`))
  assert.equal((await cli('iris', 'list')).text, 'no triggers in your rooms')
  const hidden = await cli('iris', 'delete', t.id)
  assert.equal(hidden.ok, false)
  assert.equal(hidden.text.replace(t.id, '<id>'), (await cli('iris', 'delete', 'trigger-gone')).text.replace('trigger-gone', '<id>'))
  assert.equal(store.triggers(companyId, 'room-team').length, 2)

  assert.equal((await cli('nova', 'delete', t.id)).ok, true)
  assert.equal(store.triggers(companyId, 'room-team').length, 1)
})

test('[integration] a prompt from --file or --stdin is kept as written', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'atlas' })
  await room(companyId, 'room-solo', ['atlas'])
  // The shim sends a --file/--stdin body last, behind a POSIX `--`.
  const prompt = 'Run `adb install -r "$(ls workspace/*.apk)"` --then report\\n'
  const made = await cli('atlas', 'create', 'room-solo', 'Install', '--repo', 'kargnas/heliboard', '--profile', PROFILE, '--', prompt)
  assert.equal(made.ok, true, made.text)
  assert.equal((await getForkStore()).triggers(companyId, 'room-solo')[0].prompt, prompt.trim())
})
