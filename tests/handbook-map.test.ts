/**
 * The Handbook's map and excerpts. The mistakes worth catching: a one-line
 * change disappearing when a long file is merged into a few bars, a press on
 * it landing somewhere other than the change, and a change split over two
 * places in its file showing up as two changes or at the wrong line.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HandbookFile } from '../src/next/panel/handbook.ts'
import { excerptsOf, mapOf, type MapRow } from '../src/next/panel/handbookMap.ts'

const file = (path: string): HandbookFile => ({ key: path, path, shared: false, state: 'changed', parts: [] })
const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)

test('a change in a long file keeps its colour and its row after merging', () => {
  const rows: MapRow[] = [
    { kind: 'section', section: 'memory' },
    { kind: 'file', file: file('memory/MEMORY.md') },
    { kind: 'same', lines: text(500) },
    { kind: 'change', n: 3, lines: [{ op: 'ins', text: 'added' }] },
    { kind: 'same', lines: text(500) },
    { kind: 'end' },
  ]
  const [col] = mapOf(rows)
  assert.ok(col.bars.length <= 40)
  const changed = col.bars.filter((b) => b.mark === 'ins')
  assert.equal(changed.length, 1)
  assert.equal(changed[0].row, 3)
  assert.deepEqual(col.changes, [3])
})

test('a folded skill is one bar that leads to its row', () => {
  const rows: MapRow[] = [
    { kind: 'section', section: 'skills' },
    { kind: 'file', file: file('caveman'), fold: 'closed' },
    { kind: 'file', file: file('ponytail'), fold: 'closed' },
  ]
  assert.deepEqual(mapOf(rows)[0].bars.map((b) => [b.mark, b.row]), [['fold', 1], ['fold', 2]])
})

test('excerpts group a change by number, newest first, at its line in the new text', () => {
  const rows: MapRow[] = [
    { kind: 'section', section: 'memory' },
    { kind: 'file', file: file('memory/MEMORY.md') },
    { kind: 'same', lines: text(4) },
    { kind: 'change', n: 1, lines: [{ op: 'del', text: 'old' }, { op: 'ins', text: 'new' }] },
    { kind: 'same', lines: text(2) },
    { kind: 'change', n: 1, lines: [{ op: 'ins', text: 'more' }] },
    { kind: 'change', n: 2, lines: [{ op: 'edit', segs: [['=', 'a '], ['+', 'b']] }] },
    { kind: 'end' },
  ]
  const ex = excerptsOf(rows)
  assert.deepEqual(ex.map((e) => [e.n, e.line, e.rows]), [[2, 9, [6]], [1, 5, [3, 5]]])
})
