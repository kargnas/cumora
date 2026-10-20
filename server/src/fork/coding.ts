/**
 * Coding: the T3 Code threads each agent launched, listed in the Details tab
 * (src/next/panel/CodingGroup.tsx), and a wake for the agent when one comes
 * to rest or asks a question.
 *
 * T3 keeps no record of which MCP client made a thread, so the computer marks
 * it: a Claude Code PreToolUse hook (computer/t3-tag.mjs in the deploy repo)
 * puts `[@<agent id>] ` before the title of every t3_thread_launch. Once a
 * minute the server reads every project of every T3 server for titles with
 * that mark and copies them into the fork store, so a missed poll or a restart
 * loses nothing: T3 holds the record. A thread keeps the agent and the room of
 * its first copy, so renaming it in T3 does not move it. A thread renamed
 * without its mark, archived or deleted in T3 stays as it was last read.
 *
 * compose names the T3 servers in T3_FILE (the MCP server name Claude Code
 * knows each by, its URL and its token file) and mounts the server's own T3
 * tokens read-only under TOKEN_DIR. They are approved Read only in T3, so they
 * list threads but cannot start one. They last 30 days without a refresh, so a
 * failing server is shown under the list instead of the list going quiet.
 *
 * When a thread ends or waits for the answer to a question, the agent that
 * launched it is woken through upstream's postDispatchMessage in the
 * `calendar_event` envelope, like a trigger (./triggers.ts). The hook cannot
 * tell which room the agent was working in, so the wake goes to the room of the
 * agent's model call nearest to the thread's creation: the computer's daemon
 * puts the room of each turn on its calls in upstream's llm_calls.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import { redact } from './redact.js'
import { codingWakeKey, getForkStore, type CodingThread, type NewCodingThread } from './store.js'

const POLL_MS = 60_000
// Same convention as the recorder: relative to the server's cwd, where compose
// puts the T3 server list and mounts the server's T3 tokens.
const T3_FILE = resolve(process.cwd(), 'server/computer/t3code.json')
const TOKEN_DIR = resolve(process.cwd(), 'server/computer/t3code')
const PROTOCOL = '2025-06-18'
// What computer/t3-tag.mjs puts before a title: the agent id, a slug like
// recorder.ts's AGENT_ID. T3's titleContains filter looks for its opening.
const MARK = '[@'
const MARKED = /^\[@([a-z0-9][a-z0-9._-]{0,99})\] ?/i
// Where a thread rests until someone acts on it: T3's statuses, and 'question'
// for a running thread that waits for an answer. T3's own `waiting` is not one:
// T3 shows a run that just finished as waiting while it saves the checkpoint.
const WAKE_STATUSES = ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back', 'question'] as const
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
  // Missing on older T3 servers. A state is null until T3 has read the host.
  pullRequests?: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  updatedAt: string
}
/** A marked thread as read from T3, with its question if it waits for an answer. */
type ReadThread = Omit<T3Thread, 'pullRequests'> & Pick<CodingThread, 'pullRequests' | 'requestId'>
interface ToolResult { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
interface T3Session {
  call: <T>(name: string, args: Record<string, unknown>) => Promise<T>
  /** Ends the session; T3 keeps a session it is not told about until it restarts. */
  close: () => Promise<void>
}

/** The launching agent's id and the title without its mark, or null when no agent marked the title. */
export function parseMark(title: string): { agentId: string; title: string } | null {
  const m = MARKED.exec(title)
  return m ? { agentId: m[1], title: title.slice(m[0].length) } : null
}

function t3Servers(): T3Server[] {
  if (!existsSync(T3_FILE)) return []
  return (JSON.parse(readFileSync(T3_FILE, 'utf8')) as { servers: T3Server[] }).servers
}

/** Opens an MCP session with a T3 server. */
async function connect(server: T3Server): Promise<T3Session> {
  const token = readFileSync(join(TOKEN_DIR, server.tokenFile), 'utf8').trim()
  // Checked here, without the value: fetch would put a malformed header value
  // in its error, and the error reaches the log and the Details tab.
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error(`${server.tokenFile} does not hold a one-line token`)
  let session: string | null = null
  let id = 0
  const headers = (): Record<string, string> => ({
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL } : {}),
  })
  const post = async (message: { method: string; params: object; id?: number }): Promise<unknown> => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`T3 answered ${res.status}${res.status === 401 ? ': the token may have expired' : ''}`)
    }
    session ??= res.headers.get('mcp-session-id')
    // A notification is answered with an empty 202.
    if (message.id === undefined) {
      await res.body?.cancel()
      return null
    }
    // T3 answers with JSON; the transport also allows an event stream, which T3 does not use.
    if (!res.headers.get('content-type')?.includes('application/json')) throw new Error(`T3 answered ${res.headers.get('content-type')}, not JSON`)
    const reply = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (reply.error) throw new Error(reply.error.message)
    return reply.result
  }
  await post({ id: ++id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cumora-coding', version: '1' } } })
  await post({ method: 'notifications/initialized', params: {} })
  return {
    call: async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = (await post({ id: ++id, method: 'tools/call', params: { name, arguments: args } })) as ToolResult
      if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`)
      return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null')) as T
    },
    close: async () => {
      if (!session) return
      const res = await fetch(server.url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(15_000) })
      await res.body?.cancel()
      if (!res.ok) throw new Error(`T3 answered ${res.status} to closing the session`)
    },
  }
}

/** Every thread of every project on the server whose title carries a mark.
 *  T3 lists threads per project only, for a caller outside a T3 thread.
 *  Exported for tests, which fake T3 at fetch.
 *  ponytail: one t3_thread_list per project per minute, each filtered by T3
 *  to marked titles. Skip projects without marked threads if T3 feels it. */
export async function markedThreads(server: T3Server): Promise<ReadThread[]> {
  const t3 = await connect(server)
  try {
    const projects: Array<{ id: string; deletedAt: string | null }> = []
    for (let cursor: number | undefined; ;) {
      const page = await t3.call<{ projects: typeof projects; nextCursor?: number | null }>('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
      projects.push(...page.projects)
      if (typeof page.nextCursor !== 'number' || page.projects.length === 0) break
      cursor = page.nextCursor
    }
    const threads: ReadThread[] = []
    for (const p of projects) {
      if (p.deletedAt) continue
      for (let cursor = 0; ;) {
        const page = await t3.call<{ threads: T3Thread[]; nextCursor?: number | null }>('t3_thread_list', { projectId: p.id, titleContains: MARK, limit: 100, cursor })
        for (const t of page.threads) {
          // T3 tells a question by its pending request, not by the thread's
          // status: the run stays running while it waits for the answer.
          const asked = t.status === 'running'
            ? (await t3.call<{ requestIds: string[] }>('t3_pending_request_list', { threadId: t.threadId })).requestIds
            : []
          const pullRequests = (t.pullRequests ?? []).map(({ number, url, state }) => ({ number, url, state }))
          threads.push({ ...t, pullRequests, requestId: asked[0] ?? null })
        }
        if (typeof page.nextCursor !== 'number' || page.threads.length === 0) break
        cursor = page.nextCursor
      }
    }
    return threads
  } finally {
    // A session left open costs T3 a little memory until it restarts, so a
    // failed close is logged rather than failing the poll.
    await t3.close().catch((err: unknown) => console.warn(`[fork] could not close the T3 session on ${server.name}:`, err))
  }
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

/** The room of the agent's model call nearest to `at`, within 15 minutes. The
 *  computer's daemon reports a turn's calls within a second, with the turn's
 *  room, so the call that launched the thread is already there.
 *  ponytail: a turn that answers several rooms at once records none of them,
 *  and its thread wakes nobody. */
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
  const where = `on the T3 MCP server ${t.server} (threadId ${t.threadId})`
  const question = t.status === 'question'
  return JSON.stringify({
    kind: 'calendar_event',
    eventKind: 'coding',
    // Everyone in the room can read this message, so it carries no text of the
    // thread: a title is agent text that can quote any room, which agentCoding
    // shows to owners and admins only. The agent reads the thread itself.
    title: question ? 'A T3 Code thread needs an answer' : `A T3 Code thread is ${t.status}`,
    description: `The T3 Code thread ${t.threadId} on ${t.server}, whose title carries your mark, ${question ? 'waits for an answer' : `is ${t.status}`}.`,
    agentPrompt: question
      ? `Read its question with t3_pending_request_read (requestId ${t.requestId}) ${where}. Answer it with t3_pending_request_respond when the answer is yours to give, or ask the people in this room. Never answer with a secret or a credential unless a person in this room tells you to.`
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
    console.warn(`[fork] T3 thread ${t.threadId} of ${t.agentId} is ${t.status}, but the room it was launched from is unknown`)
    store.markCodingWoken(t.server, t.threadId, key, 'the room it was launched from is unknown')
    return
  }
  // Claimed before the post, like a trigger firing (./triggers.ts): a crash
  // between the two must not wake the agent twice.
  store.markCodingWoken(t.server, t.threadId, key, null)
  try {
    // Imported here, not at the top: calendar.js loads db/pool.js and env.ts.
    const { postDispatchMessage } = await import('../calendar.js')
    await postDispatchMessage({ event: { company_id: t.companyId, assignee_id: t.agentId }, conversationId: t.conversationId, body: envelope(t) })
  } catch (err) {
    console.error(`[fork] could not wake ${t.agentId} for T3 thread ${t.threadId}:`, err)
    store.markCodingWoken(t.server, t.threadId, key, err instanceof Error ? err.message : String(err))
  }
}

// Why the last poll of each T3 server failed, shown under the coding list. The
// same failure every minute is logged once.
const pollErrors = new Map<string, string>()

async function poll(): Promise<void> {
  const seen: Array<{ server: string; thread: ReadThread; agentId: string; title: string }> = []
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
      title, status: thread.requestId ? 'question' : thread.status, runId: thread.latestRunId, requestId: thread.requestId,
      pullRequests: thread.pullRequests, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
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
