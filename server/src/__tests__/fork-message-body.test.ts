/**
 * A person's message reaches an agent up to BODY_CAP with its line breaks, and
 * the wake digest spends a fixed budget on whole bodies, newest first and only
 * on lines it prints, so the prompt stays bounded (fork/messageBody.ts).
 *
 * Run: node --import tsx --test server/src/__tests__/fork-message-body.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestKeep } from '../agents/computer/daemon.js'
import {
  BODY_CAP, DIGEST_HUMAN_CHARS, TRUNCATED, digestHumanBody, humanLine, isHumanText, wholeInDigest,
} from '../fork/messageBody.js'

type Row = { id: string; conversation_id: string; kind: string; author_kind: string; body: string }
const human = (id: string, convo: string, body: string): Row =>
  ({ id, conversation_id: convo, kind: 'text', author_kind: 'human', body })
const keepAll = (rows: Row[]) => new Map(rows.map((r) => [r.conversation_id, rows.length]))

test('a person\'s message arrives whole up to the cap and marked past it', () => {
  const atCap = 'x'.repeat(BODY_CAP)
  assert.equal(humanLine(atCap), atCap)
  assert.equal(humanLine(`${atCap}y`), `${atCap}${TRUNCATED}`)
})

test('a pasted checklist keeps its lines as \\n on one line', () => {
  assert.equal(humanLine('Ask me:\n1.  Repos?\n\n2. Profiles?  '), 'Ask me: \\n 1. Repos? \\n 2. Profiles?')
})

test('the digest shows the newest long messages whole and points back at the rest', () => {
  const rows = [1, 2, 3].map((n) => human(`m${n}`, 'direct-1', `${n} `.repeat(1400)))
  const whole = wholeInDigest(rows, keepAll(rows))
  // Two 2,800-char bodies fit the budget; the oldest one does not.
  assert.deepEqual([...whole].sort(), ['m2', 'm3'])
  const older = digestHumanBody(rows[0].body, whole.has('m1'), 'direct-1', 3)
  assert.ok(older.endsWith(`${TRUNCATED} read it whole: \`cumora messages direct-1 --tail 3\``))
  assert.ok(older.length < 700, 'past the budget a message falls back to its preview')
})

test('lines the digest drops never spend the budget', () => {
  const long = (n: number) => `${n} `.repeat(1400)
  const rows = [
    human('dm', 'direct-1', long(0)),
    human('b1', 'busy', long(1)),
    human('b2', 'busy', long(2)),
    human('b3', 'busy', long(3)),
  ]
  // Two lines in all: the DM's one and the busy room's newest.
  const keep = digestKeep([['direct-1', 1], ['busy', 3]], 2)
  assert.deepEqual([...wholeInDigest(rows, keep)].sort(), ['b3', 'dm'])
})

test('the budget counts rendered length, line breaks included', () => {
  // 4,000 raw chars that render to ~10,000 once each break becomes ` \n `.
  const rows = [human('m', 'direct-1', 'a\n'.repeat(2000))]
  assert.equal(wholeInDigest(rows, keepAll(rows)).size, 0)
  assert.ok(digestHumanBody(rows[0].body, false, 'direct-1', 1).length < 700)
})

test('the digest budget bounds the whole bodies however many arrive', () => {
  const rows = Array.from({ length: 40 }, (_, i) => human(`m${i}`, 'direct-1', 'k'.repeat(BODY_CAP)))
  const whole = wholeInDigest(rows, keepAll(rows))
  assert.ok(whole.size * BODY_CAP <= DIGEST_HUMAN_CHARS)
})

test('agent, system and short rows never spend the budget', () => {
  const rows = [
    { id: 'a', conversation_id: 'c', kind: 'text', author_kind: 'agent', body: 'a'.repeat(BODY_CAP) },
    { id: 's', conversation_id: 'c', kind: 'system', author_kind: 'human', body: 's'.repeat(BODY_CAP) },
    human('short', 'c', 'hi'),
  ]
  assert.equal(wholeInDigest(rows, keepAll(rows)).size, 0)
  // A membership notice names the person who acted, but it is not their text.
  assert.equal(isHumanText({ kind: 'system', author_kind: 'human' }), false)
  assert.equal(digestHumanBody('hi', false, 'c', 3), 'hi')
})
