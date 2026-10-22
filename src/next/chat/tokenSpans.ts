/**
 * Where developer token figures go (chat/tokens.ts loads the calls): each
 * of my messages gets the calls from it to my next one, and an agenda turn a
 * card after the message it followed. Pure, so tests/dev-token-figures.test.ts
 * can run it without a browser.
 */
import type { Item } from './model'

export interface Sub { id: string; description: string; type: string; tokens: number; toolUses: number; durationMs: number }

/** One model call, or a turn's `rest` (what its calls did not carry). `input` is the prompt part outside the cache. */
export interface Call {
  at: string
  agentId: string
  runId: string | null
  model: string
  input: number
  read: number
  write: number
  output: number
  window: number | null
  /** The Agent tool call whose subagent made this call. */
  sub: string | null
  rest: { subs: Sub[] } | null
}

export interface AgentFigures {
  agentId: string
  model: string
  calls: number
  input: number
  read: number
  write: number
  output: number
  /** The prompt of the agent's latest own call (not a subagent's), and its model's window. */
  ctx: number | null
  window: number | null
  subs: Sub[]
}

export interface Figures {
  from: string
  /** Null: up to now. */
  to: string | null
  agents: AgentFigures[]
  /** The latest own call over all agents: its prompt and window. */
  ctx: number | null
  window: number | null
  /** Cache reads over every call's whole prompt. */
  hit: number | null
}

export interface AgendaCard { runId: string; at: string; figures: Figures }

/** Figures of calls in time order, or null without any. */
export function figuresOf(calls: Call[], from: string, to: string | null): Figures | null {
  if (calls.length === 0) return null
  const byAgent = new Map<string, AgentFigures>()
  let lead: AgentFigures | null = null
  let prompt = 0
  let read = 0
  for (const c of calls) {
    let a = byAgent.get(c.agentId)
    if (!a) {
      a = { agentId: c.agentId, model: c.model, calls: 0, input: 0, read: 0, write: 0, output: 0, ctx: null, window: null, subs: [] }
      byAgent.set(c.agentId, a)
    }
    a.input += c.input
    a.read += c.read
    a.write += c.write
    a.output += c.output
    prompt += c.input + c.read + c.write
    read += c.read
    // A subagent's call carries its own model's window.
    if (c.window && !c.sub) a.window = c.window
    if (c.rest) { a.subs.push(...c.rest.subs); continue }
    a.calls += 1
    if (c.sub) continue
    a.model = c.model
    a.ctx = c.input + c.read + c.write
    lead = a
  }
  return { from, to, agents: [...byAgent.values()], ctx: lead?.ctx ?? null, window: lead?.window ?? null, hit: prompt > 0 ? read / prompt : null }
}

/** Figures under each of my messages, keyed by message id, and agenda cards
 *  after the message each turn followed. Items and calls are in time order. */
export function place(items: Item[], calls: Call[], agenda: Call[]): { byMessage: Record<string, Figures>; cardsAfter: Record<string, AgendaCard[]> } {
  const mine = items.filter((it): it is Extract<Item, { type: 'msg' }> => it.type === 'msg' && it.mine)
  const byMessage: Record<string, Figures> = {}
  let i = 0
  for (let m = 0; m < mine.length; m++) {
    const from = mine[m].at.toISOString()
    const to = mine[m + 1]?.at.toISOString() ?? null
    while (i < calls.length && calls[i].at < from) i++
    const start = i
    while (i < calls.length && (to === null || calls[i].at < to)) i++
    const f = figuresOf(calls.slice(start, i), from, to)
    if (f) byMessage[mine[m].msg.id] = f
  }
  const runs = new Map<string, Call[]>()
  for (const c of agenda) {
    const key = c.runId ?? c.at
    runs.set(key, [...(runs.get(key) ?? []), c])
  }
  const msgs = items.filter((it): it is Extract<Item, { type: 'msg' }> => it.type === 'msg')
  const cardsAfter: Record<string, AgendaCard[]> = {}
  for (const [runId, run] of runs) {
    const at = run[0].at
    // The last message at or before the turn; one before the loaded history has no place yet.
    let host: string | null = null
    for (const it of msgs) { if (it.at.toISOString() <= at) host = it.msg.id; else break }
    const figures = figuresOf(run, at, run[run.length - 1].at)
    if (host && figures) (cardsAfter[host] ??= []).push({ runId, at, figures })
  }
  return { byMessage, cardsAfter }
}
