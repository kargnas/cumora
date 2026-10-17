/**
 * The Activity tab's server side: secrets must never leave in any text it
 * returns, and runs, effects, problems and steps must group the way the panel
 * reads them (one entry per thing a run changed, each problem once, nothing
 * the viewer may not read).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STEPS, buildActivity, redact, safeText,
  type EffectRow, type EventRow, type RunRow,
} from '../fork/activity.js'

test('redact removes credentials of every listed shape', () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abc.def.ghi123" x', 'abc.def.ghi123'],
    ['Authorization=Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['sent Bearer 9f8e7d6c5b4a39281706 upstream', '9f8e7d6c5b4a39281706'],
    ['header Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', 'eyJzdWIiOiIxMjM0In0'],
    ['key sk-proj-AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIjKlMnOpQrSt'],
    ['ghp_0123456789abcdefghijABCDEFGHIJ012345 pushed', '0123456789abcdefghij'],
    ['gho_0123456789abcdefghijABCD', '0123456789abcdefghij'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '11ABCDEFG0123456789'],
    ['slack xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
    ['aws AKIAIOSFODNN7EXAMPLE done', 'AKIAIOSFODNN7EXAMPLE'],
    ['git clone https://alice:s3cretpw@github.com/x/y', 's3cretpw'],
    ['GITHUB_TOKEN=abc123 npm publish', 'abc123'],
    ['https://api.example.com/v1?api_key=zzz999&page=2', 'zzz999'],
    ['DB_PASSWORD="hunter 2" ./run', 'hunter 2'],
    ['deploy --token abc123def', 'abc123def'],
    ['deploy --api-key=xyz789', 'xyz789'],
    ['{"access_token": "tok-value-1"}', 'tok-value-1'],
    ['password: hunter2', 'hunter2'],
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `${JSON.stringify(input)} still shows ${secret}: ${out}`)
    assert.ok(out.includes('[redacted]'), `${JSON.stringify(input)} was not marked: ${out}`)
  }
  assert.equal(redact('git clone https://alice:s3cretpw@github.com/x/y'), 'git clone https://[redacted]@github.com/x/y')
  assert.equal(redact('deploy --token abc123def now'), 'deploy --token [redacted] now')
})

test('redact keeps prose that only resembles a credential', () => {
  for (const text of [
    'Authorization header missing',
    'Basic Information about the launch',
    'task-1234567890abcdefgh finished',
    'risk-assessment-for-the-quarter',
    'cumora board move card-abc Done',
  ]) {
    assert.equal(redact(text), text)
  }
})

test('safeText redacts before it cuts and keeps the first line', () => {
  const key = `sk-${'a'.repeat(40)}`
  const out = safeText(`${'x'.repeat(30)} ${key}`, 40)
  assert.ok(out && !out.includes('aaaa'), `a cut must not expose part of a key: ${out}`)
  assert.equal(safeText('Error: boom\n    at turn.ts:1:1\n    at x', 100), 'Error: boom')
  assert.equal(safeText('  \n  ', 100), null)
  assert.equal(safeText(null, 100), null)
  assert.equal(safeText('abcdefghij', 5), 'abcd…')
})

const T0 = Date.parse('2026-10-17T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000)

function run(over: Partial<RunRow> & { id: string }): RunRow {
  return {
    agentId: 'atlas', status: 'completed', summary: null, error: null,
    startedAt: at(0), updatedAt: at(60), finishedAt: at(60), durationMs: 60_000,
    costUsd: 0.05, costEstimated: true, model: 'gpt-5.5', textVisible: true,
    ...over,
  }
}

function effect(over: Partial<EffectRow> & Pick<EffectRow, 'runId' | 'kind' | 'target'>): EffectRow {
  return { at: at(10), title: 'Fix login', where: 'Sprint', count: 1, ref: null, ...over }
}

function event(over: Partial<EventRow> & Pick<EventRow, 'runId' | 'kind'>): EventRow {
  return {
    level: 'info', title: '', callId: null, name: null, arg: null, status: null,
    ok: null, durationMs: null, error: null, ...over,
  }
}

test('effects merge per run and thing, and a creation hides its own edits', () => {
  const { runs } = buildActivity({
    runs: [run({ id: 'r1' }), run({ id: 'r2', startedAt: at(100) })],
    effects: [
      effect({ runId: 'r1', kind: 'card.moved', target: 'card-1', at: at(30), where: 'Done' }),
      effect({ runId: 'r1', kind: 'card.moved', target: 'card-1', at: at(20), where: 'Doing' }),
      effect({ runId: 'r1', kind: 'card.created', target: 'card-1', at: at(5) }),
      effect({ runId: 'r1', kind: 'card.updated', target: 'card-1', at: at(25) }),
      effect({ runId: 'r1', kind: 'card.updated', target: 'card-2', at: at(26), title: 'Other card' }),
      effect({ runId: 'r1', kind: 'doc.created', target: 'doc-1', title: 'Spec' }),
      effect({ runId: 'r1', kind: 'doc.edited', target: 'doc-1', title: 'Spec' }),
      effect({ runId: 'r1', kind: 'message.posted', target: 'general', title: null, where: null, count: 2, at: at(40) }),
      effect({ runId: 'r1', kind: 'message.posted', target: 'general', title: null, where: null, count: 1, at: at(45) }),
      effect({ runId: 'r2', kind: 'card.updated', target: 'card-1', at: at(110) }),
    ],
    events: [],
    routines: [],
  }, { stepText: true })

  const r1 = runs[0].effects
  assert.deepEqual(r1.map((e) => `${e.kind}:${e.title ?? ''}`), [
    'card.created:Fix login', 'doc.created:Spec', 'card.moved:Fix login', 'card.updated:Other card', 'message.posted:',
  ])
  assert.equal(r1.find((e) => e.kind === 'card.moved')?.where, 'Done', 'a card moved twice ends in its last column')
  assert.equal(r1.find((e) => e.kind === 'message.posted')?.count, 3)
  assert.deepEqual(runs[1].effects.map((e) => e.kind), ['card.updated'], 'another run keeps its own edit of the card')
})

test('each problem shows once, and hidden text stays hidden', () => {
  const error = 'Error: 401 Unauthorized (Authorization: Bearer abcdef0123456789)\n    at x'
  const { runs } = buildActivity({
    runs: [
      run({ id: 'failed', status: 'failed', error }),
      run({ id: 'limited', status: 'failed', error: null, summary: 'rate-limited (deferred for retry)' }),
      run({ id: 'stalled', status: 'stalled', finishedAt: null }),
      run({ id: 'private', status: 'failed', error, summary: 'Turn status: done — answered Bob in his DM', textVisible: false }),
    ],
    effects: [],
    events: [
      event({ runId: 'failed', kind: 'turn.failed', level: 'error', title: 'Agent turn failed', error }),
      event({ runId: 'failed', kind: 'model.error', level: 'error', title: 'OpenAI response stream failed', error: 'Error: socket hang up' }),
      event({ runId: 'private', kind: 'turn.failed', level: 'error', title: 'Agent turn failed', error }),
    ],
    routines: [],
  }, { stepText: true })
  const [failed, limited, stalled, hidden] = runs

  assert.deepEqual(failed.problems, [
    { kind: 'failed', title: null, text: 'Error: 401 Unauthorized (Authorization: [redacted])' },
    { kind: 'error', title: 'OpenAI response stream failed', text: 'Error: socket hang up' },
  ])
  assert.deepEqual(limited.problems, [{ kind: 'failed', title: null, text: 'rate-limited (deferred for retry)' }])
  assert.deepEqual(stalled.problems, [{ kind: 'stalled', title: null, text: null }])
  assert.deepEqual(hidden.problems, [
    { kind: 'failed', title: null, text: null },
    { kind: 'error', title: 'Agent turn failed', text: null },
  ])
  assert.equal(hidden.summary, null, 'a summary that may quote a room the viewer is not in is withheld')
})

test('steps pair by call id, report failures, and show text only to owners and admins', () => {
  const events: EventRow[] = [
    event({ runId: 'r1', kind: 'tool.started', callId: 'c1', name: 'bash' }),
    event({ runId: 'r1', kind: 'tool.started', callId: 'c2', name: 'bash' }),
    event({ runId: 'r1', kind: 'tool.finished', callId: 'c1', name: 'bash', arg: 'GITHUB_TOKEN=abc123 gh pr list', status: 'ok · 120ms', ok: true, durationMs: 120 }),
    event({ runId: 'r1', kind: 'tool.finished', callId: 'c2', name: 'bash', arg: 'cumora board ls', status: 'exit 2', ok: false, durationMs: 40 }),
    event({ runId: 'r1', kind: 'tool.started', callId: 'c3', name: 'read_file' }),
  ]
  const owner = buildActivity({ runs: [run({ id: 'r1' })], effects: [], events, routines: [] }, { stepText: true }).runs[0]
  assert.deepEqual(owner.steps, [
    { name: 'bash', text: 'GITHUB_TOKEN=[redacted] gh pr list', status: 'ok · 120ms', ok: true, durationMs: 120 },
    { name: 'bash', text: 'cumora board ls', status: 'exit 2', ok: false, durationMs: 40 },
    { name: 'read_file', text: null, status: null, ok: null, durationMs: null },
  ])
  assert.deepEqual(owner.problems, [{ kind: 'step', title: 'bash', text: 'exit 2' }])

  const member = buildActivity({ runs: [run({ id: 'r1' })], effects: [], events, routines: [] }, { stepText: false }).runs[0]
  assert.ok(member.steps.every((s) => s.text === null && s.status === null))
  assert.deepEqual(member.problems, [{ kind: 'step', title: 'bash', text: null }])

  const many = Array.from({ length: MAX_STEPS + 5 }, (_, i) => event({ runId: 'r1', kind: 'tool.finished', callId: `c${i}`, name: 'bash', ok: true }))
  const capped = buildActivity({ runs: [run({ id: 'r1' })], effects: [], events: many, routines: [] }, { stepText: true }).runs[0]
  assert.equal(capped.steps.length, MAX_STEPS)
  assert.equal(capped.stepCount, MAX_STEPS + 5)
})

test('a run with no step data has no steps, and routine failures are redacted', () => {
  const out = buildActivity({
    runs: [run({ id: 'byoa' })],
    effects: [],
    events: [],
    routines: [{ id: 'cd-1', agentId: 'atlas', at: at(0), title: 'Weekly metrics', error: 'post failed: password=hunter2' }],
  }, { stepText: true })
  assert.deepEqual(out.runs[0].steps, [])
  assert.equal(out.runs[0].stepCount, 0)
  assert.deepEqual(out.routines, [{ id: 'cd-1', agentId: 'atlas', at: at(0).toISOString(), title: 'Weekly metrics', text: 'post failed: password=[redacted]' }])
})
