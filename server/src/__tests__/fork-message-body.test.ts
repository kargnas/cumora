/**
 * A person's message reaches an agent whole up to HUMAN_BODY_CHARS, while
 * agent and system rows keep each surface's short preview (fork/messageBody.ts).
 *
 * Run: node --import tsx --test server/src/__tests__/fork-message-body.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentVisibleBody, HUMAN_BODY_CHARS } from '../fork/messageBody.js'

// The shape that broke: a 1,481-char setup message cut to the digest's 600.
const setupMessage = 'Ask me these one at a time. '.repeat(53)

test('a person\'s message past the preview arrives whole', () => {
  assert.ok(setupMessage.length > 600)
  assert.equal(agentVisibleBody(setupMessage, 'human', 600), setupMessage)
})

test('a person\'s message past the cap is cut there and marked', () => {
  const huge = 'x'.repeat(HUMAN_BODY_CHARS + 50)
  assert.equal(agentVisibleBody(huge, 'human', 600), `${'x'.repeat(HUMAN_BODY_CHARS)}... [truncated]`)
})

test('agent and unknown authors keep the surface preview', () => {
  assert.equal(agentVisibleBody(setupMessage, 'agent', 600), setupMessage.slice(0, 600))
  assert.equal(agentVisibleBody(setupMessage, undefined, 280), setupMessage.slice(0, 280))
})
