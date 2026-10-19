/**
 * Transcript times (the redesign's message list). The mistakes worth catching:
 * a burst from one sender stamping every line, a long run losing its times, a
 * silence showing no line or a day change showing a pause line on top of its
 * chip, and a pause label rounding the wrong way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import { buildItems, type Item } from '../src/next/chat/model.ts'
import { pauseLength } from '../src/next/format.ts'

let n = 0
/** `at` is a local time on 2026-10-19, or a full local ISO date-time. */
const msg = (authorId: string, at: string): Message => ({
  id: `m${++n}`, conversationId: 'c', authorId, kind: 'text', body: 'x', at: '',
  createdAt: at.includes('T') ? at : `2026-10-19T${at}`,
}) as Message

const stamps = (items: Item[]) => items.map((it) => (it.type === 'msg' ? it.stamp : it.type))

test('a burst gets one time, then one more once the clock reads 5 minutes later', () => {
  // 14:05:41 → 14:10:40 is 4 min 59 s, but the reader sees 02:05 and 02:10.
  const items = buildItems([msg('a', '14:05:41'), msg('a', '14:05:58'), msg('a', '14:09:00'), msg('a', '14:10:40')], 'me')
  assert.deepEqual(stamps(items), ['turn', 'hidden', 'hidden', 'slot'])
})

test('a new sender starts a turn, and only a silence of 15 minutes draws a line', () => {
  const items = buildItems([msg('a', '14:10:40'), msg('me', '18:28:03'), msg('a', '18:29:20'), msg('a', '18:38:05')], 'me')
  assert.deepEqual(stamps(items), ['turn', 'turn', 'turn', 'slot'])
  assert.deepEqual(items.map((it) => it.pause !== null), [false, true, false, false])
})

test('a pause ends the turn; a new day shows its chip, never a pause line', () => {
  const items = buildItems([msg('a', '10:00:00'), msg('a', '10:20:00'), msg('a', '2026-10-20T09:00:00')], 'me')
  assert.deepEqual(stamps(items), ['turn', 'turn', 'turn'])
  assert.deepEqual(items.map((it) => [it.day !== null, it.pause !== null]), [[true, false], [false, true], [true, false]])
})

test('pause lengths: exact minutes, then 5-minute steps, then whole hours', () => {
  const min = 60_000
  assert.deepEqual(pauseLength(40 * min + 59_000), { h: 0, m: 40 })
  assert.deepEqual(pauseLength(148 * min), { h: 2, m: 30 })
  assert.deepEqual(pauseLength(178 * min), { h: 3, m: 0 })
  assert.deepEqual(pauseLength(258 * min), { h: 4, m: 0 })
})
