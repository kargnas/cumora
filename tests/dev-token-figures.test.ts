/**
 * Developer token figures (src/next/chat/tokens.ts). The mistakes worth
 * catching: a call landing under the wrong message, a subagent's call taking
 * the place of the agent's own context, a turn's rest counting as a call, and
 * an agenda turn landing anywhere but after the message it followed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import type { Item } from '../src/next/chat/model.ts'
import { figuresOf, place, type Call } from '../src/next/chat/tokenSpans.ts'

const msg = (id: string, at: string, mine: boolean): Item =>
  ({ type: 'msg', key: id, msg: { id } as Message, mine, pos: 'single', stamp: 'turn', day: null, pause: null, at: new Date(at) })

const call = (at: string, over: Partial<Call> = {}): Call => ({
  at, agentId: 'atlas', runId: 'run-1', model: 'claude-test', input: 2, read: 900, write: 100, output: 10,
  window: 200000, sub: null, rest: null, ...over,
})

test('each call lands under the last of my messages before it, the last one running to now', () => {
  const items = [msg('a', '2026-10-22T10:00:00.000Z', true), msg('b', '2026-10-22T10:01:00.000Z', false), msg('c', '2026-10-22T10:02:00.000Z', true)]
  const calls = [call('2026-10-22T09:59:00.000Z'), call('2026-10-22T10:00:30.000Z'), call('2026-10-22T10:01:30.000Z'), call('2026-10-22T10:05:00.000Z')]
  const { byMessage } = place(items, calls, [])
  assert.equal(byMessage.a.agents[0].calls, 2, 'a call before my first message belongs to nobody; an agent reply does not end my stretch')
  assert.equal(byMessage.a.to, '2026-10-22T10:02:00.000Z')
  assert.equal(byMessage.c.agents[0].calls, 1)
  assert.equal(byMessage.c.to, null)
  assert.equal(byMessage.b, undefined, 'only my messages carry figures')
})

test('the context is the agent\'s own latest call, and a rest adds tokens but no call', () => {
  const f = figuresOf([
    call('2026-10-22T10:00:01.000Z', { read: 1000, write: 0, input: 0 }),
    call('2026-10-22T10:00:02.000Z', { sub: 'toolu_1', read: 0, write: 5000, input: 4, window: 1000000 }),
    call('2026-10-22T10:00:03.000Z', { read: 0, write: 0, input: 0, output: 300, rest: { subs: [{ id: 'toolu_1', description: 'Look', type: 'general', tokens: 5004, toolUses: 1, durationMs: 900 }] } }),
  ], '2026-10-22T10:00:00.000Z', null)!
  assert.equal(f.ctx, 1000, 'the subagent call after it is not the agent\'s context')
  assert.equal(f.window, 200000, 'nor is its model\'s window')
  assert.equal(f.agents[0].calls, 2)
  assert.equal(f.agents[0].output, 320)
  assert.equal(f.agents[0].subs.length, 1)
  assert.equal(f.hit, 1000 / 6004)
})

test('an agenda turn is a card after the message it followed', () => {
  const items = [msg('a', '2026-10-22T10:00:00.000Z', true), msg('b', '2026-10-22T10:10:00.000Z', false)]
  const agenda = [
    call('2026-10-22T09:00:00.000Z', { runId: 'early' }),
    call('2026-10-22T10:05:00.000Z', { runId: 'run-2' }),
    call('2026-10-22T10:05:30.000Z', { runId: 'run-2' }),
    call('2026-10-22T10:11:00.000Z', { runId: 'run-3' }),
  ]
  const { cardsAfter } = place(items, [], agenda)
  assert.deepEqual(cardsAfter.a.map((c) => [c.runId, c.figures.agents[0].calls]), [['run-2', 2]])
  assert.deepEqual(cardsAfter.b.map((c) => c.runId), ['run-3'])
  assert.equal(Object.values(cardsAfter).flat().some((c) => c.runId === 'early'), false, 'a turn before the loaded history waits for older messages')
})
