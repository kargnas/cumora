/**
 * The fork's SQLite store keeps each user's chat-list layout. These cover the
 * cases where a mistake would silently lose or leak layout data: unassigning,
 * cascading a category delete, user scoping, surviving a reopen from disk, a
 * failed write or open, and the per-user caps that keep the file small.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import {
  ForkLimitError, MAX_CATEGORIES, MAX_FILE_VERSIONS, MAX_PIN_ORDER, MAX_ROOM_ASSIGNMENTS, getForkStore, openForkStore,
} from '../fork/store.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-store-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('room layout round-trips and stays per user', async () => {
  const file = join(dir, 'nested', 'fork.sqlite')
  const store = await openForkStore(file)

  const work = store.createCategory('c1', 'u1', 'Work')
  const home = store.createCategory('c1', 'u1', 'Home')
  assert.ok(home.position > work.position, 'new categories append after the last one')

  assert.equal(store.setRoomCategory('c1', 'u1', 'room-a', work.id), true)
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-b', work.id), true)
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-c', home.id), true)
  assert.deepEqual(store.layout('c1', 'u1').rooms, { 'room-a': work.id, 'room-b': work.id, 'room-c': home.id })

  // Moving to null unassigns.
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-b', null), true)
  assert.deepEqual(store.layout('c1', 'u1').rooms, { 'room-a': work.id, 'room-c': home.id })

  // Collapsed keys round-trip, including a category's own id.
  store.setCollapsed('c1', 'u1', 'other', true)
  store.setCollapsed('c1', 'u1', work.id, true)
  store.setCollapsed('c1', 'u1', 'other', false)
  assert.deepEqual(store.layout('c1', 'u1').collapsed, [work.id])

  // Reordering moves Home before Work.
  assert.equal(store.updateCategory('c1', 'u1', home.id, { name: 'House', position: 0.5 }), true)
  assert.deepEqual(store.layout('c1', 'u1').categories.map((c) => c.name), ['House', 'Work'])

  // Another user in the same company sees nothing and cannot use u1's category.
  assert.deepEqual(store.layout('c1', 'u2'), { categories: [], rooms: {}, collapsed: [], pinOrder: [] })
  assert.equal(store.setRoomCategory('c1', 'u2', 'room-a', work.id), false)
  assert.equal(store.updateCategory('c1', 'u2', work.id, { name: 'Stolen' }), false)
  assert.equal(store.deleteCategory('c1', 'u2', work.id), false)

  // Deleting a category unassigns its rooms and drops its collapsed key.
  assert.equal(store.deleteCategory('c1', 'u1', work.id), true)
  assert.equal(store.deleteCategory('c1', 'u1', work.id), false)
  assert.deepEqual(store.layout('c1', 'u1'), {
    categories: [{ id: home.id, name: 'House', position: 0.5, hidden: false }],
    rooms: { 'room-c': home.id },
    collapsed: [],
    pinOrder: [],
  })

  // A fresh store over the same file sees everything written so far.
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.layout('c1', 'u1'), store.layout('c1', 'u1'))
})

test('a failed write leaves memory as the file has it', async () => {
  const file = join(dir, 'failed-write', 'fork.sqlite')
  const store = await openForkStore(file)
  const keep = store.createCategory('c1', 'u1', 'Keep')
  const before = store.layout('c1', 'u1')

  // A directory where save() writes its temp file makes the write throw.
  mkdirSync(`${file}.tmp`)
  assert.throws(() => store.createCategory('c1', 'u1', 'Lost'))
  assert.throws(() => store.deleteCategory('c1', 'u1', keep.id))
  assert.deepEqual(store.layout('c1', 'u1'), before)

  // Once writes work again, the rolled-back changes do not reach disk either.
  rmSync(`${file}.tmp`, { recursive: true })
  store.setCollapsed('c1', 'u1', 'other', true)
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.layout('c1', 'u1'), { ...before, collapsed: ['other'] })
})

test('a failed open is retried on the next call', async (t) => {
  const file = join(dir, 'failed-open', 'fork.sqlite')
  mkdirSync(join(dir, 'failed-open'))
  writeFileSync(file, 'not a database, not a database, not a database, not a database')
  const logged = t.mock.method(console, 'error', () => {})

  await assert.rejects(getForkStore(file))
  assert.equal(logged.mock.callCount(), 1)

  rmSync(file)
  const store = await getForkStore(file)
  assert.deepEqual(store.layout('c1', 'u1'), { categories: [], rooms: {}, collapsed: [], pinOrder: [] })
  assert.equal(await getForkStore(file), store, 'a successful open is cached')
})

test('one user cannot grow the file without bound', async () => {
  const file = join(dir, 'limits', 'fork.sqlite')
  const store = await openForkStore(file)

  for (let i = 0; i < MAX_CATEGORIES; i++) store.createCategory('c1', 'u1', `Cat ${i}`)
  assert.throws(() => store.createCategory('c1', 'u1', 'One too many'), ForkLimitError)
  const cat = store.createCategory('c1', 'u2', 'Other user')

  // Collapsed keys are the built-in section or the caller's own categories.
  assert.equal(store.setCollapsed('c1', 'u2', 'other', true), true)
  assert.equal(store.setCollapsed('c1', 'u2', cat.id, true), true)
  assert.equal(store.setCollapsed('c1', 'u2', 'anything', true), false)
  assert.equal(store.setCollapsed('c1', 'u1', cat.id, true), false)
  assert.deepEqual(store.layout('c1', 'u1').collapsed, [])

  // Seeding MAX_ROOM_ASSIGNMENTS rows through the store would rewrite the file
  // that many times, so they go in with one statement.
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO room_assignments SELECT 'c1', 'u2', 'room-' || i, ? FROM n`,
    [MAX_ROOM_ASSIGNMENTS, cat.id],
  )
  writeFileSync(file, raw.export())
  const full = await openForkStore(file)

  assert.throws(() => full.setRoomCategory('c1', 'u2', 'room-new', cat.id), ForkLimitError)
  // Moving a room that is already counted, or unassigning one, still works.
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-1', cat.id), true)
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-2', null), true)
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-new', cat.id), true)
})

test('opening an older file runs the steps it has not had', async () => {
  const file = join(dir, 'migrate', 'fork.sqlite')
  const store = await openForkStore(file)
  const work = store.createCategory('c1', 'u1', 'Work')
  store.setCollapsed('c1', 'u1', work.id, true)

  // Wind the file back to schema version 1: undo the later steps, and add the
  // rows a version-1 client could write, when 'former' was a group key.
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run('ALTER TABLE room_categories DROP COLUMN hidden; DROP TABLE pin_order; DROP TABLE computer_file_versions; DROP TABLE bloub_avatars;')
  raw.run("INSERT INTO collapsed_groups VALUES ('c1', 'u1', 'former'), ('c1', 'u1', 'other')")
  raw.run('PRAGMA user_version = 1')
  writeFileSync(file, raw.export())

  const upgraded = await openForkStore(file)
  const layout = upgraded.layout('c1', 'u1')
  assert.deepEqual(layout.collapsed.sort(), [work.id, 'other'].sort())
  assert.deepEqual(layout.categories.map((c) => c.hidden), [false], 'existing categories start visible')
  upgraded.setPinOrder('c1', 'u1', ['room-a'])
  assert.deepEqual(upgraded.layout('c1', 'u1').pinOrder, ['room-a'])
  upgraded.recordFileVersions([{ scope: 'atlas', path: 'CLAUDE.md', at: '2026-10-18T00:00:00.000Z', content: 'x', baseline: true }])
  assert.equal(upgraded.latestFileVersions().length, 1)
  upgraded.setBloubAvatar('c1', 'agent-a', { shape: 'cercle', color: 'encre' })
  assert.deepEqual(Object.keys(upgraded.bloubAvatars('c1')), ['agent-a'])
})

test('file versions keep each file’s history, and `since` picks the base', async () => {
  const file = join(dir, 'versions', 'fork.sqlite')
  const store = await openForkStore(file)
  const v = (scope: string, path: string, at: string, content: string | null, baseline = false) =>
    ({ scope, path, at: `2026-10-18T${at}:00.000Z`, content, baseline })
  store.recordFileVersions([
    v('atlas', 'CLAUDE.md', '01:00', 'one', true),
    v('atlas', 'memory/MEMORY.md', '01:00', 'index', true),
    v('', 'git-lore/SKILL.md', '01:00', 'shared', true),
    v('nova', 'CLAUDE.md', '01:00', 'other agent', true),
  ])
  store.recordFileVersions([
    v('atlas', 'CLAUDE.md', '03:00', 'two'),
    v('atlas', 'CLAUDE.md', '05:00', 'three'),
    v('atlas', 'memory/MEMORY.md', '04:00', null),
  ])

  const at = (rows: Array<{ path: string; at: string; content: string | null }>) =>
    rows.map((r) => `${r.path}@${r.at.slice(11, 16)}=${r.content}`)
  // At 04:30 CLAUDE.md held "two" (its base), and only later versions follow.
  assert.deepEqual(at(store.fileVersions(['atlas', ''], '2026-10-18T04:30:00.000Z')), [
    'git-lore/SKILL.md@01:00=shared',
    'CLAUDE.md@03:00=two',
    'CLAUDE.md@05:00=three',
    'memory/MEMORY.md@04:00=null',
  ])
  assert.equal(store.fileVersions(['atlas', ''], null).length, 6, 'no since: the whole history')
  assert.deepEqual(store.fileVersions([], null), [])
  assert.deepEqual(at(store.latestFileVersions().filter((r) => r.path !== 'git-lore/SKILL.md')).sort(), [
    'CLAUDE.md@01:00=other agent',
    'CLAUDE.md@05:00=three',
    'memory/MEMORY.md@04:00=null',
  ], 'the newest version of each file, a deletion included')
  assert.deepEqual(store.fileScopes(), ['atlas', 'nova'], 'the shared folder is not an agent')

  // A failed write records nothing, so the recorder can send it again.
  mkdirSync(`${file}.tmp`)
  assert.throws(() => store.recordFileVersions([v('atlas', 'CLAUDE.md', '06:00', 'four')]))
  rmSync(`${file}.tmp`, { recursive: true })
  const reopened = await openForkStore(file)
  assert.deepEqual(at(reopened.fileVersions(['atlas'], '2026-10-18T05:30:00.000Z')), ['CLAUDE.md@05:00=three', 'memory/MEMORY.md@04:00=null'])
})

test('a bloub avatar is the agent look for the whole company, with the face of its latest message', async () => {
  const file = join(dir, 'bloub', 'fork.sqlite')
  const store = await openForkStore(file)
  store.setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'violet' })
  store.setBloubAvatar('c2', 'agent-a', { shape: 'cercle', color: 'encre' })
  assert.equal(store.bloubAvatars('c1')['agent-a']?.expression, 'neutre', 'a new look starts at rest')

  // A message's face sticks through a new pick, and a new pick replaces the row.
  assert.equal(store.setBloubExpression('c1', 'agent-a', 'heureux'), true)
  store.setBloubAvatar('c1', 'agent-a', { shape: 'nuage', color: 'rose' })
  assert.deepEqual(store.bloubAvatars('c1'), { 'agent-a': { shape: 'nuage', color: 'rose', expression: 'heureux' } })
  assert.deepEqual(store.bloubAvatars('c2'), { 'agent-a': { shape: 'cercle', color: 'encre', expression: 'neutre' } })
  assert.equal(store.setBloubExpression('c1', 'agent-b', 'triste'), false, 'an agent without a bloub gets no face')

  // Clearing one company's look leaves the other's, survives a reopen, and clearing twice is harmless.
  store.clearBloubAvatar('c1', 'agent-a')
  store.clearBloubAvatar('c1', 'agent-a')
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.bloubAvatars('c1'), {})
  assert.deepEqual(Object.keys(reopened.bloubAvatars('c2')), ['agent-a'])
})

test('faces picked before moods existed go back to rest', async () => {
  const file = join(dir, 'bloub-v5', 'fork.sqlite')
  ;(await openForkStore(file)).setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'violet' })
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run("UPDATE bloub_avatars SET expression = 'timide'; PRAGMA user_version = 5")
  writeFileSync(file, raw.export())
  assert.equal((await openForkStore(file)).bloubAvatars('c1')['agent-a']?.expression, 'neutre')
})

test('a file keeps its newest versions, and the oldest one left is its baseline', async () => {
  const store = await openForkStore(join(dir, 'prune', 'fork.sqlite'))
  const v = (path: string, i: number, baseline = false) =>
    ({ scope: 'atlas', path, at: new Date(Date.UTC(2026, 9, 18) + i * 60_000).toISOString(), content: `${path} ${i}`, baseline })
  const versionsOf = (path: string) => store.fileVersions(['atlas'], null).filter((r) => r.path === path)
  // CLAUDE.md appeared in a home already watched: a change, not a baseline.
  store.recordFileVersions([v('CLAUDE.md', 0), v('memory/MEMORY.md', 0, true)])
  store.recordFileVersions(Array.from({ length: MAX_FILE_VERSIONS - 1 }, (_, i) => v('memory/MEMORY.md', i + 1)))
  assert.equal(versionsOf('memory/MEMORY.md').length, MAX_FILE_VERSIONS, 'a file at the cap loses nothing')

  // Each version past the cap pushes the oldest out, and the oldest left
  // reads as the text first known, not as the file's creation.
  store.recordFileVersions([v('memory/MEMORY.md', MAX_FILE_VERSIONS)])
  store.recordFileVersions([v('memory/MEMORY.md', MAX_FILE_VERSIONS + 1)])
  const kept = versionsOf('memory/MEMORY.md')
  assert.equal(kept.length, MAX_FILE_VERSIONS)
  assert.deepEqual(kept.filter((r) => r.baseline).map((r) => r.content), ['memory/MEMORY.md 2'])
  assert.equal(kept.at(-1)?.content, `memory/MEMORY.md ${MAX_FILE_VERSIONS + 1}`)
  assert.deepEqual(versionsOf('CLAUDE.md').map((r) => [r.content, r.baseline]), [['CLAUDE.md 0', false]], 'a file under the cap stays as it was')

  // The pruning is on disk, not only in memory.
  const reopened = await openForkStore(join(dir, 'prune', 'fork.sqlite'))
  assert.equal(reopened.fileVersions(['atlas'], null).length, MAX_FILE_VERSIONS + 1)
})

test('hidden categories and the tile order stay per user', async () => {
  const store = await openForkStore(join(dir, 'hidden-pins', 'fork.sqlite'))
  const work = store.createCategory('c1', 'u1', 'Work')
  assert.equal(store.updateCategory('c1', 'u1', work.id, { hidden: true }), true)
  assert.deepEqual(store.layout('c1', 'u1').categories.map((c) => [c.name, c.hidden]), [['Work', true]])
  // A rename leaves the flag alone; another user cannot flip it.
  store.updateCategory('c1', 'u1', work.id, { name: 'Office' })
  assert.equal(store.layout('c1', 'u1').categories[0].hidden, true)
  assert.equal(store.updateCategory('c1', 'u2', work.id, { hidden: false }), false)

  // Setting the order replaces it, including dropping rooms left out.
  store.setPinOrder('c1', 'u1', ['room-b', 'room-a', 'room-c'])
  store.setPinOrder('c1', 'u1', ['room-c', 'room-b'])
  assert.deepEqual(store.layout('c1', 'u1').pinOrder, ['room-c', 'room-b'])
  assert.deepEqual(store.layout('c1', 'u2').pinOrder, [])
  assert.throws(() => store.setPinOrder('c1', 'u1', Array.from({ length: MAX_PIN_ORDER + 1 }, (_, i) => `room-${i}`)), ForkLimitError)
  assert.deepEqual(store.layout('c1', 'u1').pinOrder, ['room-c', 'room-b'], 'a refused order changes nothing')
})
