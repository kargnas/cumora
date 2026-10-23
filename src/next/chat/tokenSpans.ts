/**
 * Where developer token figures go (chat/tokens.ts loads the calls): each
 * of my messages gets the calls from it to my next one, and the agenda turns
 * that followed a message one card after it. Pure, so
 * tests/dev-token-figures.test.ts can run it without a browser.
 */
export interface Sub { id: string; description: string; type: string; tokens: number; toolUses: number; durationMs: number }

/** One model call, or a turn's `rest` (what its calls did not carry). `input` is the prompt part outside the cache.
 *  Mirrors TokenCall in server/src/fork/tokens.ts, like the other fork answers the redesign reads. */
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

/** The agenda turns that followed one message: each turn's figures in time
 *  order, and the figures of all their calls together. */
export interface AgendaCard { turns: Figures[]; figures: Figures }

/** A message as the figures see it: its id, time (ISO), and whether I or an agent wrote it. */
export interface Mark { id: string; at: string; mine: boolean; agent: boolean }

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

/** Figures for the calls from each of my messages to my next one, keyed by the
 *  agents' last reply in that stretch, below what it cost (a stretch without
 *  one shows nothing), and one agenda card after each message for the turns that followed it. Marks and calls are in time order.
 *  `cut`: the server dropped calls before it, so nothing that starts earlier is drawn. */
export function place(marks: Mark[], calls: Call[], agenda: Call[], cut: string | null): { byMessage: Record<string, Figures>; cardAfter: Record<string, AgendaCard> } {
  const mine = marks.filter((m) => m.mine)
  const byMessage: Record<string, Figures> = {}
  let i = 0
  let j = 0
  for (let m = 0; m < mine.length; m++) {
    const from = mine[m].at
    const to = mine[m + 1]?.at ?? null
    while (i < calls.length && calls[i].at < from) i++
    const start = i
    while (i < calls.length && (to === null || calls[i].at < to)) i++
    while (j < marks.length && marks[j].at < from) j++
    let reply: string | null = null
    for (; j < marks.length && (to === null || marks[j].at < to); j++) if (marks[j].agent) reply = marks[j].id
    const f = reply === null || (cut !== null && from < cut) ? null : figuresOf(calls.slice(start, i), from, to)
    if (f && reply) byMessage[reply] = f
  }
  const runs = new Map<string, Call[]>()
  for (const c of agenda) {
    const key = c.runId ?? c.at
    const run = runs.get(key)
    if (run) run.push(c)
    else runs.set(key, [c])
  }
  // The turns after one message share a card: while board work waits on a quiet
  // agent, a turn comes every two or three minutes (AGENDA_QUIET_MS and
  // AGENDA_CHECK_MS in the computer daemon). An agent's turns run one after
  // another, so a card's calls stay in time order.
  const after = new Map<string, Call[][]>()
  for (const run of runs.values()) {
    const at = run[0].at
    if (cut !== null && at <= cut) continue
    // The last message at or before the turn; one before the loaded history has no place yet.
    let host: string | null = null
    for (const m of marks) { if (m.at <= at) host = m.id; else break }
    if (!host) continue
    const turns = after.get(host)
    if (turns) turns.push(run)
    else after.set(host, [run])
  }
  const cardAfter: Record<string, AgendaCard> = {}
  for (const [host, turns] of after) {
    // Every run holds at least the call that opened it, so each has figures.
    const all = turns.flat()
    cardAfter[host] = {
      turns: turns.map((run) => figuresOf(run, run[0].at, run[run.length - 1].at)!),
      figures: figuresOf(all, all[0].at, all[all.length - 1].at)!,
    }
  }
  return { byMessage, cardAfter }
}
