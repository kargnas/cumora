/**
 * Developer token figures for a room (src/next/chat/tokens.ts draws them).
 *
 * GET /api/fork/rooms/:conversationId/tokens?since=<ISO time> answers the
 * room's agent model calls from upstream's `llm_calls` since that time, one
 * row per call plus each turn's `rest` row (Claude output that arrives with a
 * response's end, subagents, side calls). Only rows with `extras.acct = 2`
 * count: the daemon writes them for the persistent Claude and Codex sessions
 * since it matches the engines' own records (agents/computer/daemon.ts
 * onEngineHop); older rows double-count some calls.
 * A 1:1 room with an agent also gets that agent's agenda turns, which answer no
 * room and so appear as their own cards.
 *
 * Workspace owners and admins only, like upstream's developer tools, and only
 * members of the room. A subagent's description is agent text, so it is redacted.
 */
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import { redact } from './redact.js'

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** A room with months of loaded history stays bounded; the newest rows win. */
const MAX_ROWS = 5000

interface SubagentRun { id: string; description: string; type: string; tokens: number; toolUses: number; durationMs: number }

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

export async function roomTokens(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const conversationId = String(req.params.conversationId)
  const since = new Date(String(req.query.since ?? ''))
  if (Number.isNaN(since.getTime())) {
    res.status(400).json({ error: 'since must be an ISO time' })
    return
  }
  const { pool } = await import('../db/pool.js')
  const gate = await pool.query<{ role: string | null; member: boolean; dm_agent: string | null }>(
    `SELECT (SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $3 AND company_id = $1 AND participant_id = $2) AS member,
            (SELECT m.participant_id
               FROM conversations c
               JOIN conversation_members m ON m.conversation_id = c.id AND m.company_id = $1
               JOIN participants p ON p.id = m.participant_id AND p.company_id = $1 AND p.kind = 'agent'
              WHERE c.id = $3 AND c.company_id = $1 AND c.kind = 'direct'
              LIMIT 1) AS dm_agent`,
    [companyId, userId, conversationId],
  )
  const row = gate.rows[0]
  if (!row?.member) {
    res.status(404).json({ error: 'room not found' })
    return
  }
  if (row.role !== 'owner' && row.role !== 'admin') {
    res.status(403).json({ error: 'only workspace owners and admins can read token figures' })
    return
  }
  const { rows } = await pool.query<{
    agent_id: string; run_id: string | null; created_at: Date; model: string
    input_tokens: number; cached_input_tokens: number; cache_creation_tokens: number; output_tokens: number
    extras: Record<string, unknown> | null
  }>(
    `SELECT agent_id, run_id, created_at, model, input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, extras
       FROM llm_calls
      WHERE company_id = $1 AND purpose = 'agent-turn' AND created_at >= $2
        AND extras->>'acct' = '2'
        AND ((conversation_id = $3 AND extras->>'agenda' IS NULL)
          OR ($4::text IS NOT NULL AND agent_id = $4 AND extras->>'agenda' = 'true'))
      ORDER BY created_at DESC
      LIMIT ${MAX_ROWS}`,
    [companyId, since, conversationId, row.dm_agent],
  )
  const calls: TokenCall[] = []
  const agenda: TokenCall[] = []
  // Newest first so a cut drops the oldest; the client wants time order.
  for (const r of rows.reverse()) {
    const x = r.extras ?? {}
    const rest = x.rest as { subs?: SubagentRun[] } | undefined
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
    if (x.agenda === true) agenda.push(call)
    else calls.push(call)
  }
  res.json({ calls, agenda })
}
