/**
 * The extras the daemon writes for the chat's token figures
 * (server/src/fork/tokenRows.ts). The mistakes worth catching: a hop from a
 * path that does not match the engine's records being marked for the figures,
 * and an agenda turn's hop losing its mark.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENDA_MARK, REST_MARK, TOKEN_ACCT, tokenMarks } from '../fork/tokenRows.js'

test('only an exact hop is marked for the figures, with its window, subagent and rest', () => {
  assert.deepEqual(tokenMarks({ exact: true, window: 200000, sub: 'toolu_1' }, false), { acct: TOKEN_ACCT, window: 200000, sub: 'toolu_1' })
  assert.deepEqual(tokenMarks({ exact: true, rest: { subs: [] } }, false), { acct: TOKEN_ACCT, [REST_MARK]: { subs: [] } })
  assert.deepEqual(tokenMarks({ window: 200000, sub: 'toolu_1' }, false), {}, 'a one-shot or other-engine hop stays unmarked')
})

test('an agenda turn marks every hop, exact or not', () => {
  assert.deepEqual(tokenMarks({ exact: true }, true), { acct: TOKEN_ACCT, [AGENDA_MARK]: true })
  assert.deepEqual(tokenMarks({}, true), { [AGENDA_MARK]: true })
})
