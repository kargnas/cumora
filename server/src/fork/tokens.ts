/**
 * Developer token figures for a room (src/next/chat/tokens.ts draws them).
 *
 * GET /api/fork/rooms/:conversationId/tokens?since=<ISO time> answers the
 * room's agent model calls from upstream's `llm_calls` since that time: one
 * row per call plus each turn's `rest` rows (Claude output that arrives with a
 * response's end, subagents, side calls). Only rows marked by the daemon for
 * the persistent Claude and Codex sessions count (fork/tokenRows.ts); older
 * rows double-count some calls. A 1:1 room with an agent also gets that
 * agent's agenda turns, which answer no room and so appear as their own cards.
 *
 * Workspace owners and admins only, like upstream's developer tools, and only
 * members of the room. A subagent's description is agent text, so it is redacted.
 */
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import type { SubagentRun } from '../agents/computer/engine.js'
import { redact } from './redact.js'
import { isPrivileged } from './roles.js'
import { AGENDA_MARK, REST_MARK, TOKEN_ACCT } from './tokenRows.js'

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** A room with months of loaded history stays bounded; the newest rows win. */
export const MAX_ROWS = 5000

export interface TokenCall {
  at: string
  agentId: string
  runId: string | null
  model: string
  /** Prompt tokens neither read from nor written to the cache. */
  input: number
  read: number
  write: number
  output: number
  /** The model's context window, once the engine reported it. */
  window: number | null
  /** Claude: the Agent tool call whose subagent made this call. */
  sub: string | null
  /** Set on a turn's `rest` row. */
  rest: { subs: SubagentRun[] } | null
}

export interface RoomTokens {
  calls: TokenCall[]
  agenda: TokenCall[]
  /** Set when MAX_ROWS cut the answer: rows before this time are missing. */
  cut: string | null
}

export class TokenAccessError extends Error {
  constructor(public status: 403 | 404, message: string) { super(message) }
}

export async function readRoomTokens(companyId: string, userId: string, conversationId: string, since: Date): Promise<RoomTokens> {
  const { pool } = await import('../db/pool.js')
  const gate = await pool.query<{ role: string | null; member: boolean; agents: string[]; dm_agent: string | null }>(
    `SELECT (SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $3 AND company_id = $1 AND participant_id = $2) AS member,
            ARRAY(SELECT m.participant_id
                    FROM conversation_members m
                    JOIN participants p ON p.id = m.participant_id AND p.company_id = $1 AND p.kind = 'agent'
                   WHERE m.conversation_id = $3 AND m.company_id = $1) AS agents,
            (SELECT m.participant_id
               FROM conversations c
               JOIN conversation_members m ON m.conversation_id = c.id AND m.company_id = $1
               JOIN participants p ON p.id = m.participant_id AND p.company_id = $1 AND p.kind = 'agent'
              WHERE c.id = $3 AND c.company_id = $1 AND c.kind = 'direct'
              LIMIT 1) AS dm_agent`,
    [companyId, userId, conversationId],
  )
  const room = gate.rows[0]
  if (!room?.member) throw new TokenAccessError(404, 'room not found')
  if (!isPrivileged(room.role)) throw new TokenAccessError(403, 'only workspace owners and admins can read token figures')
  // By the room's agents, so the scan stays on their own calls (idx_llm_calls_agent_created).
  const { rows } = await pool.query<{
    agent_id: string; run_id: string | null; created_at: Date; model: string
    input_tokens: number; cached_input_tokens: number; cache_creation_tokens: number; output_tokens: number
    extras: Record<string, unknown> | null
  }>(
    `SELECT agent_id, run_id, created_at, model, input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, extras
       FROM llm_calls
      WHERE company_id = $1 AND agent_id = ANY($2::text[]) AND purpose = 'agent-turn' AND created_at >= $3
        AND extras->>'acct' = $4
        AND ((conversation_id = $5 AND extras->>$6 IS NULL)
          OR ($7::text IS NOT NULL AND agent_id = $7 AND extras->>$6 = 'true'))
      ORDER BY created_at DESC
      LIMIT ${MAX_ROWS}`,
    [companyId, room.agents, since, String(TOKEN_ACCT), conversationId, AGENDA_MARK, room.dm_agent],
  )
  const out: RoomTokens = { calls: [], agenda: [], cut: rows.length === MAX_ROWS ? rows[rows.length - 1].created_at.toISOString() : null }
  // Newest first so a cut drops the oldest; the client wants time order.
  for (const r of rows.reverse()) {
    const x = r.extras ?? {}
    const rest = x[REST_MARK] as { subs?: SubagentRun[] } | undefined
    const call: TokenCall = {
      at: r.created_at.toISOString(),
      agentId: r.agent_id,
      runId: r.run_id,
      model: r.model,
      input: r.input_tokens,
      read: r.cached_input_tokens,
      write: r.cache_creation_tokens,
      output: r.output_tokens,
      window: typeof x.window === 'number' ? x.window : null,
      sub: typeof x.sub === 'string' ? x.sub : null,
      rest: rest ? { subs: (rest.subs ?? []).map((s) => ({ ...s, description: redact(s.description) })) } : null,
    }
    if (x[AGENDA_MARK] === true) out.agenda.push(call)
    else out.calls.push(call)
  }
  return out
}

export async function roomTokens(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const since = new Date(String(req.query.since ?? ''))
  if (Number.isNaN(since.getTime())) {
    res.status(400).json({ error: 'since must be an ISO time' })
    return
  }
  try {
    res.json(await readRoomTokens(companyId, userId, String(req.params.conversationId), since))
  } catch (e) {
    if (!(e instanceof TokenAccessError)) throw e
    res.status(e.status).json({ error: e.message })
  }
}
