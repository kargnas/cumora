/**
 * Coding: the T3 Code threads each agent launched, listed in the Details tab
 * (src/next/panel/CodingGroup.tsx), and a wake for the agent when one comes
 * to rest.
 *
 * T3 keeps no record of which MCP client made a thread, so the computer marks
 * it: a Claude Code PreToolUse hook (computer/t3-tag.mjs in the deploy repo)
 * puts `[@<agent id>] ` before the title of every t3_thread_launch. Once a
 * minute the server reads every project of every T3 server for titles with
 * that mark and copies them into the fork store, so a missed poll or a restart
 * loses nothing: T3 holds the record. A thread keeps the agent and the room of
 * its first copy, so renaming it in T3 does not move it.
 *
 * compose names the T3 servers in T3_FILE (the MCP server name Claude Code
 * knows each by, its URL and its token file) and mounts the computer's T3
 * tokens read-only under TOKEN_DIR, so the server keeps no token of its own.
 * The tokens last 30 days without a refresh, so a failing server is shown
 * under the list instead of the list going quiet.
 *
 * When a thread ends or waits for an answer, the agent that launched it is
 * woken through upstream's postDispatchMessage in the `calendar_event`
 * envelope, like a trigger (./triggers.ts). The hook cannot tell which room
 * the agent was working in, so the wake goes to the room of the agent's model
 * call nearest to the thread's creation (upstream's llm_calls).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import { redact } from './redact.js'
import { codingWakeKey, getForkStore, type CodingThread, type NewCodingThread } from './store.js'

const POLL_MS = 60_000
// Same convention as the recorder: relative to the server's cwd, where compose
// puts the T3 server list and mounts the computer's T3 tokens.
const T3_FILE = resolve(process.cwd(), 'server/computer/t3code.json')
const TOKEN_DIR = resolve(process.cwd(), 'server/computer/t3code')
// What computer/t3-tag.mjs puts before a title: the agent id, a slug like
// recorder.ts's AGENT_ID. T3's titleContains filter looks for its opening.
const MARK = '[@'
const MARKED = /^\[@([a-z0-9][a-z0-9._-]{0,99})\] ?/i
// T3 statuses a thread rests in until someone acts on it.
const WAKE_STATUSES = ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back', 'waiting'] as const
// A thread first copied this long after it came to rest is history: the store
// was new or the server was down, and its agent is not woken for it.
const STALE_MS = 30 * 60_000
// ponytail: the Details tab shows each agent's 10 most recently changed
// threads; page the route if someone needs the older ones there.
const LIST = 10

interface T3Server { name: string; url: string; tokenFile: string }
interface T3Thread {
  threadId: string
  title: string
  status: string
  latestRunId: string | null
  pullRequests: Array<{ number: number; url: string; state: string }>
  createdAt: string
  updatedAt: string
}
interface ToolResult { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }

/** The launching agent's id and the title without its mark, or null when no agent marked the title. */
export function parseMark(title: string): { agentId: string; title: string } | null {
  const m = MARKED.exec(title)
  return m ? { agentId: m[1], title: title.slice(m[0].length) } : null
}

function t3Servers(): T3Server[] {
  if (!existsSync(T3_FILE)) return []
  return (JSON.parse(readFileSync(T3_FILE, 'utf8')) as { servers: T3Server[] }).servers
}

/** Opens an MCP session with a T3 server and returns a function that calls one of its tools. */
async function connect(server: T3Server): Promise<<T>(name: string, args: Record<string, unknown>) => Promise<T>> {
  const token = readFileSync(join(TOKEN_DIR, server.tokenFile), 'utf8').trim()
  let session: string | null = null
  let id = 0
  const post = async (message: { method: string; params: object; id?: number }): Promise<unknown> => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`T3 answered ${res.status}${res.status === 401 ? ': the token may have expired' : ''}`)
    session ??= res.headers.get('mcp-session-id')
    // A notification is answered with an empty 202.
    if (message.id === undefined) return null
    // T3 answers with JSON; the transport also allows an event stream, which T3 does not use.
    if (!res.headers.get('content-type')?.includes('application/json')) throw new Error(`T3 answered ${res.headers.get('content-type')}, not JSON`)
    const reply = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (reply.error) throw new Error(reply.error.message)
    return reply.result
  }
  await post({ id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cumora-coding', version: '1' } } })
  await post({ method: 'notifications/initialized', params: {} })
  return async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = (await post({ id: ++id, method: 'tools/call', params: { name, arguments: args } })) as ToolResult
    if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`)
    return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null')) as T
  }
}

/** Every thread of every project on the server whose title carries a mark.
 *  T3 lists threads per project only, for a caller outside a T3 thread.
 *  ponytail: one t3_thread_list per project per minute, each filtered by T3
 *  to marked titles. Skip projects without marked threads if T3 feels it. */
async function markedThreads(server: T3Server): Promise<T3Thread[]> {
  const call = await connect(server)
  const projects: Array<{ id: string; deletedAt: string | null }> = []
  for (let cursor: number | undefined; ;) {
    const page = await call<{ projects: typeof projects; nextCursor?: number | null }>('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    projects.push(...page.projects)
    if (typeof page.nextCursor !== 'number' || page.projects.length === 0) break
    cursor = page.nextCursor
  }
  const threads: T3Thread[] = []
  for (const p of projects) {
    if (p.deletedAt) continue
    for (let cursor = 0; ;) {
      const page = await call<{ threads: T3Thread[]; nextCursor?: number | null }>('t3_thread_list', { projectId: p.id, titleContains: MARK, limit: 100, cursor })
      threads.push(...page.threads)
      if (typeof page.nextCursor !== 'number' || page.threads.length === 0) break
      cursor = page.nextCursor
    }
  }
  return threads
}

/** The workspace of each id that is an agent; ids that are not stay out. */
async function agentCompanies(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  // Imported here, not at the top: db/pool.js loads env.ts, which exits
  // without OPENAI_API_KEY and would kill the tests that import this module.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ id: string; company_id: string }>(
    `SELECT id, company_id FROM participants WHERE id = ANY($1::text[]) AND kind = 'agent'`,
    [ids],
  )
  return new Map(rows.map((r) => [r.id, r.company_id]))
}

/** The room of the agent's model call nearest to `at`, within 15 minutes.
 *  ponytail: an agent that works in two rooms within minutes of a launch may
 *  get the wake in the other one. */
async function roomNear(agentId: string, at: string): Promise<string | null> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM llm_calls
      WHERE agent_id = $1 AND conversation_id IS NOT NULL
        AND created_at BETWEEN $2::timestamptz - interval '15 minutes' AND $2::timestamptz + interval '15 minutes'
      ORDER BY abs(extract(epoch FROM created_at - $2::timestamptz)) LIMIT 1`,
    [agentId, at],
  )
  return rows[0]?.conversation_id ?? null
}

function envelope(t: CodingThread): string {
  const prs = t.pullRequests.map((p) => `${p.url} (${p.state})`).join('\n')
  const where = `on the T3 MCP server ${t.server} (threadId ${t.threadId})`
  return JSON.stringify({
    kind: 'calendar_event',
    eventKind: 'coding',
    title: `T3 thread ${t.status}: ${t.title}`,
    description: `The T3 Code thread "${t.title}" you launched ${where} is ${t.status}.${prs ? `\nPull requests:\n${prs}` : ''}`,
    agentPrompt: t.status === 'waiting'
      ? `It waits for an answer. Read its request with t3_pending_request_list and t3_pending_request_read ${where}, then answer it with t3_pending_request_respond, or ask the people in this room when the answer is theirs.`
      : `Read how it went with t3_thread_read ${where} and tell this room in a short message, unless you already did.`,
    assigneeId: t.agentId,
    targetConversationId: t.conversationId,
    scheduledFor: t.updatedAt,
  })
}

async function wake(t: CodingThread): Promise<void> {
  const store = await getForkStore()
  const key = codingWakeKey(t)
  if (!t.conversationId) {
    store.markCodingWoken(t.server, t.threadId, key, 'the room it was launched from is unknown')
    return
  }
  try {
    // Imported here, not at the top: calendar.js loads db/pool.js and env.ts.
    const { postDispatchMessage } = await import('../calendar.js')
    await postDispatchMessage({ event: { company_id: t.companyId, assignee_id: t.agentId }, conversationId: t.conversationId, body: envelope(t) })
    store.markCodingWoken(t.server, t.threadId, key, null)
  } catch (err) {
    console.error(`[fork] could not wake ${t.agentId} for T3 thread ${t.threadId}:`, err)
    store.markCodingWoken(t.server, t.threadId, key, err instanceof Error ? err.message : String(err))
  }
}

// Why the last poll of each T3 server failed, shown under the coding list. The
// same failure every minute is logged once.
const pollErrors = new Map<string, string>()

async function poll(): Promise<void> {
  const seen: Array<{ server: string; thread: T3Thread; agentId: string; title: string }> = []
  for (const server of t3Servers()) {
    try {
      for (const thread of await markedThreads(server)) {
        const mark = parseMark(thread.title)
        if (mark) seen.push({ server: server.name, thread, ...mark })
      }
      pollErrors.delete(server.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (pollErrors.get(server.name) !== message) console.error(`[fork] T3 poll of ${server.name} failed:`, err)
      pollErrors.set(server.name, message)
    }
  }
  const store = await getForkStore()
  const companies = await agentCompanies([...new Set(seen.map((s) => s.agentId))])
  const known = store.codingThreadKeys()
  const threads: NewCodingThread[] = []
  for (const { server, thread, agentId, title } of seen) {
    const companyId = companies.get(agentId)
    if (!companyId) continue
    const fresh = !known.has(`${server} ${thread.threadId}`)
    const t: CodingThread = {
      server, threadId: thread.threadId, companyId, agentId,
      conversationId: fresh ? await roomNear(agentId, thread.createdAt) : null,
      title, status: thread.status, runId: thread.latestRunId,
      pullRequests: thread.pullRequests.map(({ number, url, state }) => ({ number, url, state })),
      createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    }
    threads.push({ ...t, woken: fresh && Date.now() - Date.parse(t.updatedAt) > STALE_MS ? codingWakeKey(t) : null })
  }
  store.saveCodingThreads(threads)
  for (const t of store.codingWakesDue(WAKE_STATUSES)) await wake(t)
}

let started = false

export function startCodingPoller(): void {
  if (started) return
  started = true
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await poll()
    } catch (err) {
      console.error('[fork] coding poll failed:', err)
    } finally {
      busy = false
    }
  }
  setTimeout(() => void tick(), 15_000).unref()
  setInterval(() => void tick(), POLL_MS).unref()
}

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** GET /api/fork/agents/:agentId/coding, for workspace owners and admins: a
 *  thread's title is agent text, which can quote any room. */
export async function agentCoding(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const agentId = String(req.params.agentId)
  const { pool } = await import('../db/pool.js')
  const gate = await pool.query<{ role: string | null; agent: boolean }>(
    `SELECT (SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM participants WHERE id = $3 AND company_id = $1 AND kind = 'agent') AS agent`,
    [companyId, userId, agentId],
  )
  const role = gate.rows[0]?.role
  if (role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'only workspace owners and admins can read what agents code' })
    return
  }
  if (!gate.rows[0].agent) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const threads = (await getForkStore()).codingThreads(companyId, agentId, LIST)
  res.json({
    threads: threads.map((t) => ({
      server: t.server, threadId: t.threadId, title: redact(t.title), status: t.status,
      pullRequests: t.pullRequests, createdAt: t.createdAt, updatedAt: t.updatedAt,
    })),
    servers: t3Servers().map((s) => ({ name: s.name, error: pollErrors.get(s.name) ?? null })),
  })
}
