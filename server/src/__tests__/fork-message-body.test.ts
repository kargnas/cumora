/**
 * A person's message reaches an agent up to BODY_CAP with its line breaks, and
 * the wake digest spends a fixed budget on whole bodies, newest first, so the
 * prompt stays bounded (fork/messageBody.ts).
 *
 * Run: node --import tsx --test server/src/__tests__/fork-message-body.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BODY_CAP, DIGEST_HUMAN_CHARS, TRUNCATED, digestHumanBody, humanLine, wholeInDigest,
} from '../fork/messageBody.js'

test('a person\'s message arrives whole up to the cap and marked past it', () => {
  const atCap = 'x'.repeat(BODY_CAP)
  assert.equal(humanLine(atCap), atCap)
  assert.equal(humanLine(`${atCap}y`), `${atCap}${TRUNCATED}`)
})

test('a pasted checklist keeps its lines as \\n on one line', () => {
  assert.equal(humanLine('Ask me:\n1.  Repos?\n\n2. Profiles?  '), 'Ask me: \\n 1. Repos? \\n 2. Profiles?')
})

test('the digest shows the newest long messages whole and points at the rest', () => {
  const long = (n: number) => `${n} `.repeat(1400)
  const rows = [1, 2, 3].map((n) => ({ id: `m${n}`, kind: 'text', author_kind: 'human', body: long(n) }))
  const whole = wholeInDigest(rows)
  // Two 2,800-char bodies fit the budget; the oldest one does not.
  assert.deepEqual([...whole].sort(), ['m2', 'm3'])
  const older = digestHumanBody(rows[0].body, whole.has('m1'), 'direct-1')
  assert.ok(older.length < 700, 'past the budget a message falls back to its preview')
  assert.ok(older.endsWith(`${TRUNCATED} read it whole: \`cumora messages direct-1\``))
})

test('the digest budget bounds the whole bodies however many arrive', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, kind: 'text', author_kind: 'human', body: 'k'.repeat(BODY_CAP) }))
  const whole = wholeInDigest(rows)
  assert.ok(whole.size * BODY_CAP <= DIGEST_HUMAN_CHARS)
})

test('agent, system and short rows never spend the budget', () => {
  const rows = [
    { id: 'a', kind: 'text', author_kind: 'agent', body: 'a'.repeat(BODY_CAP) },
    { id: 's', kind: 'system', author_kind: 'human', body: 's'.repeat(BODY_CAP) },
    { id: 'short', kind: 'text', author_kind: 'human', body: 'hi' },
  ]
  assert.equal(wholeInDigest(rows).size, 0)
  assert.equal(digestHumanBody('hi', false, 'c'), 'hi')
})
