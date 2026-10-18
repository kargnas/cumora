/**
 * The Handbook: what the recorder stores from the computer's files (and what
 * it must never read), and how stored versions become a document with each
 * change marked where it happened, numbered in time order and tied to the
 * right instruction, as of any time.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHandbook, ownedVersions, type Attribution, type Handbook, type HandbookFile } from '../fork/handbook.js'
import { createRecorder, MAX_FILE_BYTES, MAX_HOME_FILES } from '../fork/recorder.js'
import { openForkStore, type FileVersion } from '../fork/store.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-handbook-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const T = (hhmm: string) => `2026-10-18T${hhmm}:00.000Z`
let nextId = 1
const version = (scope: string, path: string, at: string, content: string | null, baseline = false): FileVersion =>
  ({ id: nextId++, scope, path, at: T(at), content, baseline })

/** Versions in the order FileStore.fileVersions returns them. */
const ordered = (vs: FileVersion[]) =>
  [...vs].sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path) || a.at.localeCompare(b.at) || a.id - b.id)

function files(h: Handbook): HandbookFile[] {
  assert.ok(h.available)
  return h.sections.flatMap((s) => s.files)
}
const file = (h: Handbook, path: string) => files(h).find((f) => f.path === path)

test('a baseline is the text first seen, not a change', () => {
  const h = buildHandbook([version('atlas', 'CLAUDE.md', '01:00', '# Rules\n- Be brief\n', true)], { since: T('00:00'), at: null }, new Map())
  assert.ok(h.available)
  assert.deepEqual(h.changes, [])
  assert.deepEqual(file(h, 'CLAUDE.md'), { key: 'atlas:CLAUDE.md', path: 'CLAUDE.md', shared: false, state: 'same', parts: [{ same: ['# Rules', '- Be brief'] }] })
})

test('changes are numbered in time order and marked where they happened', () => {
  const vs = ordered([
    version('atlas', 'CLAUDE.md', '01:00', '# Rules\n- Reply in English\n- Ask before merging\n', true),
    version('atlas', 'CLAUDE.md', '02:00', '# Rules\n- Reply in Korean\n- Ask before merging\n'),
    version('atlas', 'memory/MEMORY.md', '01:00', '- [Prefs](prefs.md)\n', true),
    version('atlas', 'memory/prefs.md', '03:00', 'Digest at 9am\n'),
    version('atlas', 'CLAUDE.md', '04:00', '# Rules\n- Reply in Korean\n- Ask before merging\n- Post digests to #eng\n'),
  ])
  const now = buildHandbook(vs, { since: T('00:00'), at: null }, new Map())
  assert.ok(now.available)
  assert.deepEqual(now.changes.map((c) => [c.n, c.path, c.kind]), [
    [1, 'CLAUDE.md', 'edited'], [2, 'memory/prefs.md', 'created'], [3, 'CLAUDE.md', 'edited'],
  ])
  assert.deepEqual(file(now, 'CLAUDE.md')?.parts, [
    { same: ['# Rules'] },
    { change: 1, lines: [{ op: 'edit', segs: [['=', '- Reply in '], ['-', 'English'], ['+', 'Korean']] }] },
    { same: ['- Ask before merging'] },
    { change: 3, lines: [{ op: 'ins', text: '- Post digests to #eng' }] },
  ])
  assert.equal(file(now, 'memory/prefs.md')?.state, 'created')
  assert.deepEqual(files(now).map((f) => f.path), ['CLAUDE.md', 'memory/MEMORY.md', 'memory/prefs.md'], 'MEMORY.md leads its section')

  // As of 02:30 only the first change happened; the later ones stay listed for the scrubber.
  const earlier = buildHandbook(vs, { since: T('00:00'), at: T('02:30') }, new Map())
  assert.ok(earlier.available)
  assert.equal(earlier.changes.length, 3)
  assert.equal(file(earlier, 'memory/prefs.md'), undefined, 'not created yet')
  assert.deepEqual(file(earlier, 'CLAUDE.md')?.parts.map((p) => ('change' in p ? p.change : 0)), [0, 1, 0])

  // Since 02:30 the Korean line is the base text, and numbering starts again.
  const later = buildHandbook(vs, { since: T('02:30'), at: null }, new Map())
  assert.ok(later.available)
  assert.deepEqual(later.changes.map((c) => [c.n, c.path]), [[1, 'memory/prefs.md'], [2, 'CLAUDE.md']])
  assert.deepEqual(file(later, 'CLAUDE.md')?.parts, [
    { same: ['# Rules', '- Reply in Korean', '- Ask before merging'] },
    { change: 2, lines: [{ op: 'ins', text: '- Post digests to #eng' }] },
  ])
})

test('each line keeps the change that made it, and deletions show what was there', () => {
  const vs = ordered([
    version('atlas', 'memory/MEMORY.md', '01:00', 'a\nReply in English\nc\n', true),
    // Change 1 rewrites the second line; change 4 adds one above it and removes c.
    version('atlas', 'memory/MEMORY.md', '02:00', 'a\nReply in Korean\nc\n'),
    version('atlas', 'memory/MEMORY.md', '03:00', 'a\nnew\nReply in Korean\n'),
    version('atlas', 'memory/old.md', '01:00', 'keep this\n', true),
    version('atlas', 'memory/old.md', '04:00', null),
    // Made and removed inside the range: nothing left to show, but still changes.
    version('atlas', 'memory/tmp.md', '02:00', 'scratch\n'),
    version('atlas', 'memory/tmp.md', '02:10', null),
  ])
  const h = buildHandbook(vs, { since: null, at: null }, new Map())
  assert.ok(h.available)
  assert.deepEqual(h.changes.map((c) => `${c.n} ${c.path} ${c.kind}`), [
    '1 memory/MEMORY.md edited', '2 memory/tmp.md created', '3 memory/tmp.md deleted', '4 memory/MEMORY.md edited', '5 memory/old.md deleted',
  ])
  assert.deepEqual(file(h, 'memory/MEMORY.md')?.parts, [
    { same: ['a'] },
    { change: 4, lines: [{ op: 'ins', text: 'new' }] },
    { change: 1, lines: [{ op: 'edit', segs: [['=', 'Reply in '], ['-', 'English'], ['+', 'Korean']] }] },
    { change: 4, lines: [{ op: 'del', text: 'c' }] },
  ])
  assert.deepEqual(file(h, 'memory/old.md'), {
    key: 'atlas:memory/old.md', path: 'memory/old.md', shared: false, state: 'deleted',
    parts: [{ change: 5, lines: [{ op: 'del', text: 'keep this' }] }],
  })
  assert.equal(file(h, 'memory/tmp.md'), undefined)
})

test('sections run instructions, memory, then own and shared skills, with secrets redacted', () => {
  const vs = ordered([
    version('', 'git-lore/SKILL.md', '01:00', 'shared skill\n', true),
    version('atlas', '.claude/skills/digest/SKILL.md', '01:00', 'own skill\n', true),
    version('atlas', 'memory/zeta.md', '01:00', 'z\n', true),
    version('atlas', 'memory/MEMORY.md', '01:00', 'index\n', true),
    version('atlas', 'CLAUDE.md', '01:00', 'Run GITHUB_TOKEN=abc123 gh pr list\n', true),
  ])
  const h = buildHandbook(vs, { since: null, at: null }, new Map())
  assert.ok(h.available)
  assert.deepEqual(h.sections.map((s) => [s.key, s.files.map((f) => f.path)]), [
    ['instructions', ['CLAUDE.md']],
    ['memory', ['memory/MEMORY.md', 'memory/zeta.md']],
    ['skills', ['.claude/skills/digest/SKILL.md', '~/.agents/skills/git-lore/SKILL.md']],
  ])
  assert.deepEqual(file(h, 'CLAUDE.md')?.parts, [{ same: ['Run GITHUB_TOKEN=[redacted] gh pr list'] }])
  assert.equal(file(h, '~/.agents/skills/git-lore/SKILL.md')?.shared, true)
})

test('a private key reads as one line in every version, so the edits around it line up', () => {
  const key = (body: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`
  const vs = ordered([
    version('atlas', 'memory/deploy.md', '01:00', `Deploy key:\n${key('b3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACD')}\nUse it for prod\n`, true),
    // The key is rotated (a different number of lines) and the last line edited.
    version('atlas', 'memory/deploy.md', '02:00', `Deploy key:\n${key('AAAAC3NzaC1lZDI1NTE5AAAA\nIHRoaXMgaXMgbmV3\nZm9yIHN0YWdpbmc=')}\nUse it for staging\n`),
  ])
  const h = buildHandbook(vs, { since: null, at: null }, new Map())
  assert.deepEqual(file(h, 'memory/deploy.md')?.parts, [
    { same: ['Deploy key:', '-----BEGIN OPENSSH PRIVATE KEY-----[redacted]-----END OPENSSH PRIVATE KEY-----'] },
    { change: 1, lines: [{ op: 'edit', segs: [['=', 'Use it for '], ['-', 'prod'], ['+', 'staging']] }] },
  ])
})

test('an agent id used again does not bring back the files of the agent that had it before', () => {
  // atlas of a hard-deleted workspace kept notes; another workspace's atlas joined its first room at 04:00.
  const vs = ordered([
    version('atlas', 'CLAUDE.md', '01:00', '# Old workspace rules\n', true),
    version('atlas', 'memory/MEMORY.md', '01:00', '- [Acme](acme.md)\n', true),
    version('atlas', 'memory/acme.md', '02:00', 'Acme renews in May\n'),
    version('atlas', 'memory/acme.md', '03:00', null),
    version('atlas', 'CLAUDE.md', '05:00', '# New rules\n'),
    version('', 'git-lore/SKILL.md', '01:00', 'shared\n', true),
  ])
  const h = buildHandbook(ownedVersions(vs, T('04:00')), { since: null, at: null }, new Map())
  assert.ok(h.available)
  assert.ok(!/Old workspace|Acme/.test(JSON.stringify(h)), 'nothing of the earlier agent shows')
  assert.deepEqual(h.changes.map((c) => [c.n, c.path, c.kind]), [[1, 'CLAUDE.md', 'created']])
  assert.deepEqual(files(h).map((f) => f.path), ['CLAUDE.md', '~/.agents/skills/git-lore/SKILL.md'])

  // An agent in no room of the workspace owns none of its own files' versions.
  const roomless = buildHandbook(ownedVersions(vs, null), { since: null, at: null }, new Map())
  assert.deepEqual(files(roomless).map((f) => f.path), ['~/.agents/skills/git-lore/SKILL.md'])
})

test('changes carry the run and the instruction they were matched to', () => {
  const edit = version('atlas', 'CLAUDE.md', '02:00', 'b\n')
  const attribution = new Map<number, Attribution>([[edit.id, {
    agentId: 'atlas',
    instruction: { authorId: 'u1', at: T('01:59'), visible: true, conversationId: 'dm-1', messageId: 'm-1', text: 'Say b' },
  }]])
  const h = buildHandbook(ordered([version('atlas', 'CLAUDE.md', '01:00', 'a\n', true), edit]), { since: null, at: null }, attribution)
  assert.ok(h.available)
  assert.deepEqual(h.changes, [{
    n: 1, at: T('02:00'), path: 'CLAUDE.md', kind: 'edited', agentId: 'atlas',
    instruction: { authorId: 'u1', at: T('01:59'), visible: true, conversationId: 'dm-1', messageId: 'm-1', text: 'Say b' },
  }])
})

test('the recorder stores what the computer holds and nothing it must not read', async () => {
  const root = join(dir, 'computer')
  const roots = { agents: join(root, 'agents'), skills: join(root, 'skills') }
  const write = (path: string, text: string, mtime?: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
    if (mtime) utimesSync(path, new Date(mtime), new Date(mtime))
  }
  const home = join(roots.agents, 'atlas')
  write(join(home, 'CLAUDE.md'), '# Atlas\n', T('01:00'))
  write(join(home, 'memory', 'MEMORY.md'), '- index\n')
  write(join(home, 'memory', 'topics', 'deploys.md'), 'deploy on Fridays\n')
  write(join(home, '.claude', 'skills', 'digest', 'SKILL.md'), 'digest skill\n')
  write(join(roots.skills, 'git-lore', 'SKILL.md'), 'shared\n')
  // Not whitelisted, not an agent id, a link out of the home, and too big.
  write(join(home, 'notes', 'reply.md'), 'draft\n')
  write(join(roots.agents, 'Not An Id', 'CLAUDE.md'), 'x\n')
  write(join(dir, 'outside', 'secret.md'), 'password: hunter2\n')
  symlinkSync(join(dir, 'outside', 'secret.md'), join(home, 'memory', 'leak.md'))
  symlinkSync(join(dir, 'outside'), join(roots.agents, 'linked'))
  write(join(home, 'memory', 'huge.md'), 'x'.repeat(MAX_FILE_BYTES + 1))

  const store = await openForkStore(join(dir, 'recorder.sqlite'))
  let clock = Date.parse(T('10:00'))
  const poll = createRecorder(store, roots, () => clock)
  const recorded = () => store.fileVersions(['atlas', 'nova', ''], null).map((v) => `${v.scope}:${v.path}${v.baseline ? ' (baseline)' : ''}=${v.content}`)

  assert.equal(poll(), 5)
  assert.deepEqual(recorded().sort(), [
    ':git-lore/SKILL.md (baseline)=shared\n',
    'atlas:.claude/skills/digest/SKILL.md (baseline)=digest skill\n',
    'atlas:CLAUDE.md (baseline)=# Atlas\n',
    'atlas:memory/MEMORY.md (baseline)=- index\n',
    'atlas:memory/topics/deploys.md (baseline)=deploy on Fridays\n',
  ])
  assert.equal(store.fileVersions(['atlas'], null).find((v) => v.path === 'CLAUDE.md')?.at, T('01:00'), 'dated by mtime')

  // An edit is a change at its mtime; a touch that keeps the text is not.
  write(join(home, 'CLAUDE.md'), '# Atlas\n- Be brief\n', T('10:01'))
  utimesSync(join(home, 'memory', 'MEMORY.md'), new Date(T('10:02')), new Date(T('10:02')))
  assert.equal(poll(), 1)
  const edit = store.latestFileVersions().find((v) => v.path === 'CLAUDE.md')
  assert.deepEqual([edit?.at, edit?.baseline, edit?.content], [T('10:01'), false, '# Atlas\n- Be brief\n'])

  // New files show up on the next listing: in a watched home a change, in a
  // new home (an agent's first turn) a baseline. A deletion is a tombstone.
  write(join(home, 'memory', 'prefs.md'), 'digest at 9\n', T('10:03'))
  write(join(roots.agents, 'nova', 'AGENTS.md'), 'nova\n', T('10:03'))
  rmSync(join(home, 'memory', 'MEMORY.md'))
  assert.equal(poll(), 1, 'the deletion shows at once, new files wait for the listing')
  clock += 60_000
  assert.equal(poll(), 2)
  const latest = new Map(store.latestFileVersions().map((v) => [`${v.scope}:${v.path}`, v]))
  assert.equal(latest.get('atlas:memory/MEMORY.md')?.content, null)
  assert.equal(latest.get('atlas:memory/prefs.md')?.baseline, false)
  assert.equal(latest.get('nova:AGENTS.md')?.baseline, true)

  // A folder that is no longer mounted says nothing about its files.
  renameSync(roots.skills, join(root, 'skills-away'))
  clock += 60_000
  assert.equal(poll(), 0)
  assert.equal(store.latestFileVersions().find((v) => v.scope === '')?.content, 'shared\n')

  // A fresh recorder over the same store picks up where the last one stopped.
  assert.equal(createRecorder(store, roots, () => clock)(), 0)
})

test('the recorder scans a bounded number of files in a home, the files every agent has first', async () => {
  const roots = { agents: join(dir, 'full', 'agents'), skills: join(dir, 'full', 'skills') }
  const home = join(roots.agents, 'atlas')
  mkdirSync(join(home, 'memory', 'notes'), { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '# Atlas\n')
  writeFileSync(join(home, 'memory', 'MEMORY.md'), '- index\n')
  for (let i = 0; i < MAX_HOME_FILES + 50; i++) writeFileSync(join(home, 'memory', 'notes', `${i}.md`), `note ${i}\n`)

  const store = await openForkStore(join(dir, 'full.sqlite'))
  createRecorder(store, roots, () => Date.parse(T('10:00')))()
  const paths = store.fileVersions(['atlas'], null).map((v) => v.path)
  assert.ok(paths.includes('CLAUDE.md') && paths.includes('memory/MEMORY.md'))
  // CLAUDE.md, AGENTS.md and MEMORY.md are looked up by name, outside the scan's budget.
  assert.ok(paths.length <= MAX_HOME_FILES + 3, `${paths.length} files recorded`)
})
