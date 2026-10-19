/**
 * The mark computer/t3-tag.mjs (deploy repo) puts before a T3 thread title is
 * the only link between a thread and the agent that launched it. Reading it
 * wrong lists a thread under nobody or under the wrong agent, so it is pinned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMark } from '../fork/coding.js'

test('a leading mark names the agent, and the rest is the title', () => {
  assert.deepEqual(parseMark('[@credential-manager] 헤더 수정'), { agentId: 'credential-manager', title: '헤더 수정' })
  assert.deepEqual(parseMark('[@pr-summary-bot] [@other] x'), { agentId: 'pr-summary-bot', title: '[@other] x' }, 'the first mark wins')
  assert.equal(parseMark('헤더 [@bot] 수정'), null, 'a mark inside the title is not one')
  assert.equal(parseMark('[@] x'), null)
  assert.equal(parseMark('[@two words] x'), null)
  assert.equal(parseMark('Fix the header'), null)
})
