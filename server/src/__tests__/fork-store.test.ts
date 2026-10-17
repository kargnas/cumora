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
  ForkLimitError, MAX_CATEGORIES, MAX_ROOM_ASSIGNMENTS, getForkStore, openForkStore,
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
  assert.deepEqual(store.layout('c1', 'u2'), { categories: [], rooms: {}, collapsed: [] })
  assert.equal(store.setRoomCategory('c1', 'u2', 'room-a', work.id), false)
  assert.equal(store.updateCategory('c1', 'u2', work.id, { name: 'Stolen' }), false)
  assert.equal(store.deleteCategory('c1', 'u2', work.id), false)

  // Deleting a category unassigns its rooms and drops its collapsed key.
  assert.equal(store.deleteCategory('c1', 'u1', work.id), true)
  assert.equal(store.deleteCategory('c1', 'u1', work.id), false)
  assert.deepEqual(store.layout('c1', 'u1'), {
    categories: [{ id: home.id, name: 'House', position: 0.5 }],
    rooms: { 'room-c': home.id },
    collapsed: [],
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
  assert.deepEqual(store.layout('c1', 'u1'), { categories: [], rooms: {}, collapsed: [] })
  assert.equal(await getForkStore(file), store, 'a successful open is cached')
})

test('one user cannot grow the file without bound', async () => {
  const file = join(dir, 'limits', 'fork.sqlite')
  const store = await openForkStore(file)

  for (let i = 0; i < MAX_CATEGORIES; i++) store.createCategory('c1', 'u1', `Cat ${i}`)
  assert.throws(() => store.createCategory('c1', 'u1', 'One too many'), ForkLimitError)
  const cat = store.createCategory('c1', 'u2', 'Other user')

  // Collapsed keys are the built-in sections or the caller's own categories.
  assert.equal(store.setCollapsed('c1', 'u2', 'other', true), true)
  assert.equal(store.setCollapsed('c1', 'u2', 'former', true), true)
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
