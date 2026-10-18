/**
 * A BYOA turn reports what the agent is doing: thinking, then working after a
 * hop that called tools. Clients animate the agent's avatar from it, so a
 * status that lands out of order (a tool hop's `working` after the turn's
 * closing `avail`) would leave the agent looking busy after it finished.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRunner } from '../agents/computer/daemon.js'
import type { EngineHopReport, EngineToolCall } from '../agents/computer/engine.js'

type Runner = {
  postStatus(token: string, status: 'avail' | 'thinking' | 'working', tool?: string | null): Promise<void>
  beatStatus(token: string): () => void
  onEngineHop(report: EngineHopReport, purpose: 'agent-turn'): void
}

const hop = (...tools: EngineToolCall[]): EngineHopReport => ({ model: 'fixture-model', usage: { input_tokens: 1, output_tokens: 1 }, toolUses: tools.length, tools })

test('tool hops switch the turn to working, and status posts keep their order', async (t) => {
  const posted: string[] = []
  const pending: Array<() => void> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (!String(url).endsWith('/runtime/status')) return Response.json({})
    const { status, tool } = JSON.parse(String(init.body)) as { status: string; tool?: string | null }
    // The first post (thinking) answers only after the later ones were sent.
    if (posted.length === 0 && pending.length === 0) await new Promise<void>((resolve) => pending.push(resolve))
    posted.push(tool === undefined ? status : `${status}:${tool}`)
    return Response.json({ ok: true })
  })
  const runner = new AgentRunner(
    { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' },
    { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null },
    'claude',
  ) as unknown as Runner

  const thinking = runner.postStatus('tok', 'thinking')
  const stop = runner.beatStatus('tok')
  runner.onEngineHop(hop({ name: 'Read' }, { name: 'Grep' }), 'agent-turn')
  // Still working, but now writing a reply through the CLI: the new kind is posted too.
  runner.onEngineHop(hop({ name: 'Bash', command: 'cumora reply --to room "done"' }), 'agent-turn')
  runner.onEngineHop(hop({ name: 'mcp__linear__create_issue' }), 'agent-turn')
  stop()
  // Outside a turn a hop changes nothing.
  runner.onEngineHop(hop(), 'agent-turn')
  const avail = runner.postStatus('tok', 'avail')
  while (pending.length === 0) await new Promise((resolve) => setImmediate(resolve))
  pending.shift()?.()
  await Promise.all([thinking, avail])
  assert.deepEqual(posted, ['thinking', 'working:read', 'working:write', 'working:null', 'avail'])
})
