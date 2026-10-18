/**
 * A BYOA turn reports what the agent is doing: thinking, then working from its
 * first hop that called tools until the turn ends. Clients animate the agent's
 * avatar from it, so a status that lands out of order (a tool hop's `working`
 * after the turn's closing `avail`) would leave the agent looking busy after it
 * finished, and a status that flips on every hop would make it twitch.
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { AgentRunner } from '../agents/computer/daemon.js'
import type { EngineHopReport, EngineToolCall } from '../agents/computer/engine.js'

type Runner = {
  ensureToken(): Promise<string>
  postStatus(token: string, status: 'avail' | 'thinking' | 'working', tool?: string | null): Promise<void>
  beatStatus(token: string): () => void
  onEngineHop(report: EngineHopReport, purpose: 'agent-turn'): void
  statusPump: Promise<void> | null
}

const hop = (...tools: EngineToolCall[]): EngineHopReport => ({ model: 'fixture-model', usage: { input_tokens: 1, output_tokens: 1 }, toolUses: tools.length, tools })

/** A runner whose status POSTs are recorded as `status` or `status:tool` when
 *  they are sent; the first one answers only once `firstAnswered` settles. */
function fixture(t: TestContext, firstAnswered: Promise<void> = Promise.resolve()) {
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (!String(url).endsWith('/runtime/status')) return Response.json({})
    const { status, tool } = JSON.parse(String(init.body)) as { status: string; tool?: string | null }
    sent.push(tool === undefined ? status : `${status}:${tool}`)
    if (sent.length === 1) await firstAnswered
    return Response.json({ ok: true })
  })
  const runner = new AgentRunner(
    { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' },
    { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null },
    'claude',
  ) as unknown as Runner
  t.mock.method(runner, 'ensureToken', async () => 'tok')
  return { runner, sent }
}

test('statuses asked for behind a post in flight collapse to the newest, and nothing lands after avail', async (t) => {
  let answer = (): void => {}
  const { runner, sent } = fixture(t, new Promise<void>((resolve) => { answer = resolve }))

  const thinking = runner.postStatus('tok', 'thinking')
  while (sent.length === 0) await new Promise((resolve) => setImmediate(resolve))
  // The turn runs on while its `thinking` is still in flight.
  const stop = runner.beatStatus('tok')
  runner.onEngineHop(hop({ name: 'Read' }, { name: 'Grep' }), 'agent-turn')
  runner.onEngineHop(hop({ name: 'Bash', command: 'cumora reply --to room "done"' }), 'agent-turn')
  stop()
  const avail = runner.postStatus('tok', 'avail')
  answer()
  await Promise.all([thinking, avail])
  assert.deepEqual(sent, ['thinking', 'avail'])
})

test('a tool hop turns the agent to working for the rest of the turn, and each new kind of tool is posted once', async (t) => {
  const { runner, sent } = fixture(t)
  const step = async (report: EngineHopReport) => {
    runner.onEngineHop(report, 'agent-turn')
    await runner.statusPump
  }

  await runner.postStatus('tok', 'thinking')
  const stop = runner.beatStatus('tok')
  await step(hop({ name: 'Read' }))
  // Claude Code reports the text between two tool calls as a hop of its own.
  await step(hop())
  await step(hop({ name: 'Bash', command: 'cumora reply --to room "done"' }))
  await step(hop({ name: 'Bash', command: 'cumora reply --to room "and more"' }))
  stop()
  await runner.postStatus('tok', 'avail')
  // Outside a turn a hop changes nothing.
  await step(hop({ name: 'Read' }))
  assert.deepEqual(sent, ['thinking', 'working:read', 'working:write', 'avail'])
})
