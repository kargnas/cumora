/**
 * Deleting an agent for good, the parts outside Postgres: what the fork store
 * drops and queues, the Handbook recorder leaving a home that waits for its
 * computer, and which files the computer removes. The last is where a mistake
 * deletes another agent's transcripts, since Claude Code's folder names map
 * '/' and '-' alike.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeAgentFiles } from '../fork/computer-purge.js'
import { createRecorder } from '../fork/recorder.js'
import { openForkStore } from '../fork/store.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-purge-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const write = (path: string, text = 'x\n') => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

test('the store drops the agent and queues its files for its computer only', async () => {
  const store = await openForkStore(join(dir, 'store.sqlite'))
  store.setBloubAvatar('c1', 'atlas', { shape: 'goutte', color: 'rose' })
  store.setBloubAvatar('c1', 'nova', { shape: 'goutte', color: 'rose' })
  const own = store.createTrigger({ companyId: 'c1', createdBy: 'u1', conversationId: 'dm', assigneeId: 'atlas', title: 't', prompt: 'p', repo: 'o/r', profile: 'gh' })
  const other = store.createTrigger({ companyId: 'c1', createdBy: 'u1', conversationId: 'room', assigneeId: 'nova', title: 't', prompt: 'p', repo: 'o/r', profile: 'gh' })
  store.claimFire(own.id, 'pr:1', '2026-10-20T00:00:00.000Z', '#1')
  const work = store.createCategory('c1', 'u1', 'Work')
  store.setRoomCategory('c1', 'u1', 'dm', work.id)
  store.setRoomCategory('c1', 'u1', 'room', work.id)
  store.setPinOrder('c1', 'u1', ['dm', 'room'])

  store.purgeAgent('c1', 'atlas', ['dm'], 'computer-1')

  assert.deepEqual(Object.keys(store.bloubAvatars('c1')), ['nova'])
  assert.equal(store.trigger('c1', own.id), null)
  assert.ok(store.trigger('c1', other.id))
  const layout = store.layout('c1', 'u1')
  assert.deepEqual(layout.rooms, { room: work.id })
  assert.deepEqual(layout.pinOrder, ['room'])
  assert.deepEqual(store.computerPurges('computer-1'), ['atlas'])
  assert.deepEqual(store.computerPurges('computer-2'), [])

  // Another computer cannot clear it; its own computer can.
  store.clearComputerPurge('computer-2', 'atlas')
  assert.deepEqual([...store.purgingAgents()], ['atlas'])
  store.clearComputerPurge('computer-1', 'atlas')
  assert.deepEqual(store.computerPurges('computer-1'), [])

  // A cloud agent has no computer to clean.
  store.purgeAgent('c1', 'nova', [], null)
  assert.deepEqual([...store.purgingAgents()], [])
})

test('the Handbook leaves a home that waits for its computer, and a later agent under the id starts fresh', async () => {
  const roots = { agents: join(dir, 'rec', 'agents'), skills: join(dir, 'rec', 'skills') }
  const home = join(roots.agents, 'atlas')
  write(join(home, 'CLAUDE.md'), '# Atlas\n')
  write(join(home, 'memory', 'MEMORY.md'), '- index\n')
  const store = await openForkStore(join(dir, 'rec.sqlite'))
  let clock = Date.parse('2026-10-20T10:00:00.000Z')
  const poll = createRecorder(store, roots, () => clock)
  assert.equal(poll(), 2)

  store.purgeAgent('c1', 'atlas', [], 'computer-1')
  assert.deepEqual(store.fileVersions(['atlas'], null), [])
  write(join(home, 'CLAUDE.md'), '# Atlas, edited\n')
  clock += 60_000
  assert.equal(poll(), 0, 'nothing recorded while the home waits')

  // The computer removes the home and clears the queue: no deletions follow.
  rmSync(home, { recursive: true })
  store.clearComputerPurge('computer-1', 'atlas')
  clock += 60_000
  assert.equal(poll(), 0)

  write(join(home, 'CLAUDE.md'), '# New Atlas\n')
  clock += 60_000
  assert.equal(poll(), 1)
  assert.deepEqual(store.fileVersions(['atlas'], null).map((v) => [v.path, v.baseline, v.content]), [['CLAUDE.md', true, '# New Atlas\n']])
})

test('the computer removes the agent\'s home, sessions and transcripts, and nothing of agents sharing its prefix', async () => {
  const root = join(dir, 'computer')
  const claude = join(root, '.claude')
  const agents = join(root, '.cumora', 'agents')
  const project = (agent: string, sub = '') => join(claude, 'projects', join(agents, agent, sub).replace(/[^a-zA-Z0-9]/g, '-'))
  for (const agent of ['pr', 'pr-summary-bot', 'velvet']) {
    write(join(agents, agent, 'CLAUDE.md'))
    write(join(root, '.cumora', 'sessions', agent, 'claude.session'))
    write(join(project(agent), 's.jsonl'))
  }
  write(join(project('pr', 'workspace'), 's.jsonl'))
  write(join(project('pr-summary-bot', 'workspace'), 's.jsonl'))
  write(join(root, '.cumora', 'sessions', 'pr.session'))

  await removeAgentFiles('pr', root, claude)

  assert.deepEqual(readdirSync(agents).sort(), ['pr-summary-bot', 'velvet'])
  assert.deepEqual(readdirSync(join(root, '.cumora', 'sessions')).sort(), ['pr-summary-bot', 'velvet'])
  assert.deepEqual(readdirSync(join(claude, 'projects')).sort(), [
    project('pr-summary-bot'), project('pr-summary-bot', 'workspace'), project('velvet'),
  ].map((p) => p.slice(join(claude, 'projects').length + 1)).sort())

  // Removing again is a no-op, and a path is never built from a non-id.
  await removeAgentFiles('pr', root, claude)
  await assert.rejects(removeAgentFiles('../velvet', root, claude))
  assert.ok(existsSync(join(agents, 'velvet')))
})
