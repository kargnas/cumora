/**
 * The T3 side of the coding list (server/src/fork/coding.ts). The mark
 * computer/t3-tag.mjs (deploy repo) puts before a T3 thread title is the only
 * link between a thread and the agent that launched it, so reading it wrong
 * lists a thread under nobody or under the wrong agent. A poll reads T3 as an
 * MCP client; T3 is faked at fetch with the shapes T3 answers with, so what is
 * pinned is that contract: paging, a question found through the pending
 * requests, a thread without a pull request list, and the session closed.
 */
import { test, after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// coding.ts finds its T3 tokens relative to the server's cwd when it loads.
const root = mkdtempSync(join(tmpdir(), 'fork-coding-'))
mkdirSync(join(root, 'server/computer/t3code'), { recursive: true })
writeFileSync(join(root, 'server/computer/t3code/tok'), 'token-123\n')
writeFileSync(join(root, 'server/computer/t3code/bad'), 'token-line-one\ntoken-line-two\n')
const cwd = process.cwd()
process.chdir(root)
const { markedThreads, parseMark } = await import('../fork/coding.js')
process.chdir(cwd)
after(() => rmSync(root, { recursive: true, force: true }))

const server = (tokenFile: string) => ({ name: 't3code', url: 'http://t3.example.test/mcp', tokenFile })
const thread = (threadId: string, status: string, more: object = {}) => ({
  threadId, title: `[@bot] ${threadId}`, status, latestRunId: `run-${threadId}`, settled: false,
  pullRequests: [], createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:05:00.000Z', ...more,
})

/** A T3 that answers like the real one, recording each tool call and the session's end. */
function fakeT3(t: TestContext, tool: (name: string, args: Record<string, unknown>) => unknown): string[] {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    assert.equal(headers.authorization, 'Bearer token-123')
    if (init.method === 'DELETE') {
      calls.push(`DELETE ${headers['mcp-session-id']}`)
      return new Response(null, { status: 204 })
    }
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } }
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's-1' } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    assert.equal(headers['mcp-session-id'], 's-1')
    calls.push(`${body.params.name} ${JSON.stringify(body.params.arguments)}`)
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: tool(body.params.name, body.params.arguments) } })
  })
  return calls
}

test('a leading mark names the agent, and the rest is the title', () => {
  assert.deepEqual(parseMark('[@credential-manager] 헤더 수정'), { agentId: 'credential-manager', title: '헤더 수정' })
  assert.deepEqual(parseMark('[@pr-summary-bot] [@other] x'), { agentId: 'pr-summary-bot', title: '[@other] x' }, 'the first mark wins')
  assert.deepEqual(parseMark('[@Disagree · coroner] HeliBoard 빌드'), { agentId: 'coroner', title: 'HeliBoard 빌드' }, 'a renamed agent shows its name before its id')
  assert.deepEqual(parseMark('[@A · B · coroner] x'), { agentId: 'coroner', title: 'x' }, 'the id is the last part')
  assert.equal(parseMark('헤더 [@bot] 수정'), null, 'a mark inside the title is not one')
  assert.equal(parseMark('[@] x'), null)
  assert.equal(parseMark('[@two words] x'), null)
  assert.equal(parseMark('[@Disagree · two words] x'), null)
  assert.equal(parseMark('Fix the header'), null)
})

test('a poll reads every page of every live project, asks running threads for a question, and closes its session', async (t) => {
  const calls = fakeT3(t, (name, args) => {
    if (name === 't3_project_list') return { projects: [{ id: 'p1', deletedAt: null }, { id: 'p-gone', deletedAt: '2026-10-01T00:00:00.000Z' }], nextCursor: null }
    if (name === 't3_thread_list' && args.cursor === 0) {
      return {
        threads: [
          thread('th-1', 'running'),
          // T3's own `waiting`: a run that just finished, while T3 saves its checkpoint.
          thread('th-2', 'waiting', { pullRequests: [{ host: 'github.com', number: 7, url: 'https://github.com/o/r/pull/7', source: 'agent', state: null }] }),
        ],
        nextCursor: 2,
      }
    }
    // An older T3 server sends no pull request list at all.
    if (name === 't3_thread_list') return { threads: [thread('th-3', 'completed', { pullRequests: undefined })], nextCursor: null }
    if (name === 't3_pending_request_list') return { requestIds: args.threadId === 'th-1' ? ['q-1'] : [] }
    throw new Error(`unexpected ${name}`)
  })

  const threads = await markedThreads(server('tok'))

  assert.deepEqual(threads.map((x) => [x.threadId, x.status, x.requestId, x.pullRequests]), [
    ['th-1', 'running', 'q-1', []],
    ['th-2', 'waiting', null, [{ number: 7, url: 'https://github.com/o/r/pull/7', state: null }]],
    ['th-3', 'completed', null, []],
  ])
  assert.deepEqual(calls, [
    't3_project_list {"limit":100}',
    't3_thread_list {"projectId":"p1","titleContains":"[@","limit":100,"cursor":0}',
    't3_pending_request_list {"threadId":"th-1"}',
    't3_thread_list {"projectId":"p1","titleContains":"[@","limit":100,"cursor":2}',
    'DELETE s-1',
  ])
})

test('a poll that fails still closes its session, and a malformed token fails without its value', async (t) => {
  const calls = fakeT3(t, () => {
    throw new Error('T3 is down')
  })
  await assert.rejects(markedThreads(server('tok')))
  assert.deepEqual(calls.at(-1), 'DELETE s-1')

  await assert.rejects(markedThreads(server('bad')), (err: Error) => !err.message.includes('token-line'))
})
