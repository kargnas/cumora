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
  ForkLimitError, MAX_CATEGORIES, MAX_PIN_ORDER, MAX_ROOM_ASSIGNMENTS, getForkStore, openForkStore,
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
  raw.run('ALTER TABLE room_categories DROP COLUMN hidden; DROP TABLE pin_order;')
  raw.run("INSERT INTO collapsed_groups VALUES ('c1', 'u1', 'former'), ('c1', 'u1', 'other')")
  raw.run('PRAGMA user_version = 1')
  writeFileSync(file, raw.export())

  const upgraded = await openForkStore(file)
  const layout = upgraded.layout('c1', 'u1')
  assert.deepEqual(layout.collapsed.sort(), [work.id, 'other'].sort())
  assert.deepEqual(layout.categories.map((c) => c.hidden), [false], 'existing categories start visible')
  upgraded.setPinOrder('c1', 'u1', ['room-a'])
  assert.deepEqual(upgraded.layout('c1', 'u1').pinOrder, ['room-a'])
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
