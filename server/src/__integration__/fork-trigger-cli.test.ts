/**
 * `cumora trigger` against a real Postgres (server/src/fork/triggers.ts): an
 * agent makes, sees and deletes triggers only in rooms it is in, for agents in
 * that room, under the Routines tab's rule, and a room or trigger it cannot see
 * answers like one that does not exist. A mistake here lets an agent wake
 * someone in a room it cannot see, remove another room's trigger, learn which
 * rooms and triggers exist, or show a secret its prompt quotes in the Routines
 * tab or the CLI.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../db/pool.js'
import { parseArgs } from '../agents/cli-parse.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

// The fork store and the gh profiles resolve from the server's cwd when their
// modules load, so this test runs them in a directory of its own.
const home = process.cwd()
// Real path: on macOS the cwd reads /private/var/... for a tmpdir() under /var.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fork-trigger-cli-')))
process.chdir(dir)
const { getForkStore } = await import('../fork/store.js')
const { GH_DIR, runTriggerCli } = await import('../fork/triggers.js')

const PROFILE = 'trigger-cli-test'
// The person in the rooms, as the API test app signs every request in.
const OWNER = 'u-owner'
let server: Server
let baseUrl = ''

before(async () => {
  assert.ok(GH_DIR.startsWith(dir), 'the gh profiles must come from the test directory')
  await ensureSchemaOnce()
  server = createServer(await buildApiTestApp(OWNER))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
  mkdirSync(join(GH_DIR, PROFILE), { recursive: true })
  writeFileSync(join(GH_DIR, PROFILE, 'hosts.yml'), 'github.com:\n    oauth_token: gho_test\n')
})
beforeEach(async () => { await resetAllTables() })
after(async () => {
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
  await teardownAll(server)
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
  await seedUserMembership(OWNER, companyId)
  await room(companyId, 'room-team', [OWNER, 'atlas', 'nova'])
  await room(companyId, 'room-iris', ['iris'])
  const store = await getForkStore()
  const count = () => store.triggers(companyId, 'room-team').length + store.triggers(companyId, 'room-iris').length

  // A room the agent is not in reads like a room that does not exist.
  const outside = await create('atlas', 'room-iris')
  assert.match(outside.text, /you are not in room-iris/)
  assert.equal(outside.text.replace('room-iris', '<room>'), (await create('atlas', 'room-gone')).text.replace('room-gone', '<room>'))
  // Only an agent of the room is woken, and a bare --assignee is not "me".
  assert.match((await create('atlas', 'room-team', '--assignee', 'iris')).text, /iris is not an agent in room-team/)
  assert.match((await create('atlas', 'room-team', '--assignee', OWNER)).text, new RegExp(`${OWNER} is not an agent in room-team`))
  assert.match((await create('atlas', 'room-team', '--assignee')).text, /^usage: /)
  // With no gh profile signed in, the answer says so rather than listing none.
  renameSync(join(GH_DIR, PROFILE), join(dir, 'parked'))
  assert.equal((await create('atlas', 'room-team')).text, 'no gh profile is signed in on the computer')
  renameSync(join(dir, 'parked'), join(GH_DIR, PROFILE))
  assert.equal(count(), 0)

  assert.equal((await create('atlas', 'room-team')).ok, true)
  assert.equal(store.triggers(companyId, 'room-team')[0].assigneeId, 'atlas', 'the assignee defaults to the caller')
  // One trigger per room, repository and assignee, whatever the case of the name.
  const again = await cli('atlas', 'create', 'room-team', 'Again', '--repo', 'Kargnas/HeliBoard', '--profile', PROFILE, '--prompt', 'Install')
  assert.match(again.text, /already wakes @atlas in room-team/)
  // A trigger a person paused still counts, so an agent cannot route around the pause.
  store.updateTrigger(companyId, store.triggers(companyId, 'room-team')[0].id, { status: 'paused' })
  assert.match((await create('atlas', 'room-team')).text, /\(paused\) already wakes @atlas/)
  assert.equal(count(), 1)
  // Words that would be dropped without a word are refused: an unquoted title,
  // or a prompt given both as --prompt and after `--`.
  assert.match((await cli('atlas', 'create', 'room-team', 'Install', 'on', 'merge', '--repo', 'kargnas/x', '--profile', PROFILE, '--prompt', 'p')).text, /^usage: /)
  assert.match((await cli('atlas', 'create', 'room-team', 'Install', '--repo', 'kargnas/x', '--profile', PROFILE, '--prompt', 'p', '--', 'q')).text, /^usage: /)
  assert.equal(count(), 1)
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

test('[integration] a secret in an agent\'s prompt is redacted in the tab and the CLI, and kept for the fire', async () => {
  const { companyId } = await seedCompanyWithAgent({ agentId: 'atlas' })
  await seedUserMembership(OWNER, companyId)
  await room(companyId, 'room-team', [OWNER, 'atlas'])
  const token = `ghp_${'x1'.repeat(15)}`
  const made = await cli('atlas', 'create', 'room-team', `Install ${token}`, '--repo', 'kargnas/heliboard', '--profile', PROFILE, '--prompt', `Install with GITHUB_TOKEN=${token}`)
  assert.equal(made.ok, true, made.text)

  const res = await fetch(`${baseUrl}/api/fork/triggers?conversation=room-team`, { headers: { 'x-company-id': companyId } })
  assert.equal(res.status, 200)
  const { triggers } = (await res.json()) as { triggers: Array<{ prompt: string }> }
  assert.equal(triggers[0].prompt, 'Install with GITHUB_TOKEN=[redacted]', 'the Routines tab')
  assert.ok(!JSON.stringify(triggers).includes(token), 'the Routines tab, title included')
  assert.ok(!(await cli('atlas', 'list')).text.includes(token), 'cumora trigger list')
  assert.equal((await getForkStore()).triggers(companyId, 'room-team')[0].prompt, `Install with GITHUB_TOKEN=${token}`, 'the brief a fire posts')
  const [t] = (await getForkStore()).triggers(companyId, 'room-team')
  assert.ok(!(await cli('atlas', 'delete', t.id)).text.includes(token), 'cumora trigger delete')
})
