/**
 * The redesign's Activity tab: the agent runs of one room, with what each run
 * changed outside the chat, what went wrong, its time and cost, and the steps
 * when the engine reported any. Reads upstream Postgres and writes nothing.
 *
 * A run belongs to the room when its trigger names the room, its input
 * messages are the room's, its LLM calls carry the room, or its agent posted
 * in the room while it ran. BYOA runs need the last rule: the computer daemon
 * creates them with no room and no input messages, and its hop ledger rows
 * lose the room once the wake is consumed, which happens before the engine
 * starts.
 *
 * An effect belongs to a run by agent and time: from the run's start until it
 * finished plus GRACE, cut at the agent's next run so two runs never share
 * one. Free text (summary, errors, titles, step text) is redacted and capped.
 */
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'

export type RunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stalled'

export type EffectKind =
  | 'card.created' | 'card.moved' | 'card.updated' | 'card.deleted' | 'comment.created'
  | 'board.created' | 'doc.created' | 'doc.edited' | 'doc.deleted' | 'event.created'
  | 'message.posted'

export type EffectRef =
  | { type: 'board'; id: string; cardId: string | null }
  | { type: 'doc'; id: string }
  | { type: 'event'; id: string }
  | { type: 'room'; id: string; messageId: string }

export interface ActivityEffect {
  kind: EffectKind
  /** Card, board, doc or event title. Null for a deleted doc and for rooms, which the client names. */
  title: string | null
  /** Board title for card changes, the destination column for a move. */
  where: string | null
  count: number
  /** What a click opens; null when the thing is gone. */
  ref: EffectRef | null
}

export interface ActivityProblem {
  kind: 'failed' | 'stalled' | 'error' | 'step'
  /** Event title, or the tool name of a failed step. */
  title: string | null
  text: string | null
}

export interface ActivityStep {
  name: string
  /** The tool's short display text (a command, a path). Owners and admins only. */
  text: string | null
  status: string | null
  /** null while the step is still running. */
  ok: boolean | null
  durationMs: number | null
}

export interface ActivityRun {
  id: string
  agentId: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  updatedAt: string
  durationMs: number
  costUsd: number
  costEstimated: boolean
  model: string | null
  summary: string | null
  effects: ActivityEffect[]
  problems: ActivityProblem[]
  steps: ActivityStep[]
  /** Steps the run reported; above `steps.length` when the list was capped. */
  stepCount: number
}

/** A routine that should have posted into the room and could not. */
export interface RoutineFailure {
  id: string
  agentId: string | null
  at: string
  title: string | null
  text: string | null
}

export interface RoomActivity {
  runs: ActivityRun[]
  routines: RoutineFailure[]
}

/* ── Redaction ─────────────────────────────────────────────────────── */

const R = '[redacted]'
const SECRET_NAME = '(?:token|key|secret|password|passwd)'

// Base64 credentials always carry a digit, '+', '/', '=' or a capital after
// the first letter; "Basic Information" carries none, so prose survives.
function looksEncoded(token: string): boolean {
  return /[0-9+/=]/.test(token) || /[A-Z]/.test(token.slice(1))
}

// Order matters: whole headers and URLs go before the bare token shapes that
// would otherwise eat only part of them.
const SECRET_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${R}@`],
  [/\b((?:proxy-)?authorization)\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?[^\s,;'"()[\]{}]+/gi, `$1: ${R}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  [/\b(basic)\s+([A-Za-z0-9+/]{8,}={0,2})/gi, (match, scheme, token) => (looksEncoded(token) ? `${scheme} ${R}` : match)],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  [new RegExp(`(--[a-z0-9-]*${SECRET_NAME}[a-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${R}`],
  [new RegExp(`\\b([A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\\s&"']+)`, 'gi'), `$1=${R}`],
  [new RegExp(`("[A-Za-z0-9_-]*${SECRET_NAME}[A-Za-z0-9_-]*"\\s*:\\s*)"[^"]*"`, 'gi'), `$1"${R}"`],
  [/\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*:\s*[^\s,;]+/gi, `$1: ${R}`],
]

export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string)
  }
  return out
}

/** One line of at most `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Redact before cutting: a cut can split a secret into a shape the patterns no
 *  longer match. Errors keep their first line, which drops stack traces. */
export function safeText(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null
  const firstLine = redact(raw).split('\n').find((line) => line.trim()) ?? ''
  return clip(firstLine, max) || null
}

/* ── Grouping ──────────────────────────────────────────────────────── */

export interface RunRow {
  id: string
  agentId: string
  status: RunStatus
  summary: string | null
  error: string | null
  startedAt: Date
  updatedAt: Date
  finishedAt: Date | null
  durationMs: number
  costUsd: number
  costEstimated: boolean
  model: string | null
  /** The viewer is in every room the run's trigger names (BYOA triggers name none). */
  textVisible: boolean
}

export interface EffectRow {
  runId: string
  kind: EffectKind
  at: Date
  /** Rows with the same run, kind and target merge into one effect. */
  target: string
  title: string | null
  where: string | null
  count: number
  ref: EffectRef | null
}

export interface EventRow {
  runId: string
  kind: string
  level: string
  title: string
  callId: string | null
  name: string | null
  arg: string | null
  status: string | null
  ok: boolean | null
  durationMs: number | null
  error: string | null
}

export interface RoutineRow {
  id: string
  agentId: string | null
  at: Date
  title: string | null
  error: string | null
}

export const MAX_STEPS = 40
const MAX_PROBLEMS = 6

// A card or doc the run created also counts as edited by the same run; the
// creation already says it.
const SHADOWED_BY: Partial<Record<EffectKind, EffectKind>> = {
  'card.updated': 'card.created',
  'doc.edited': 'doc.created',
}

function groupEffects(rows: EffectRow[]): Map<string, ActivityEffect[]> {
  type Acc = ActivityEffect & { first: number; last: number }
  const byRun = new Map<string, Map<string, Acc>>()
  for (const row of rows) {
    let merged = byRun.get(row.runId)
    if (!merged) byRun.set(row.runId, (merged = new Map()))
    const key = `${row.kind}:${row.target}`
    const at = row.at.getTime()
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, {
        kind: row.kind, title: safeText(row.title, 120), where: safeText(row.where, 80),
        count: row.count, ref: row.ref, first: at, last: at,
      })
      continue
    }
    prev.count += row.count
    prev.first = Math.min(prev.first, at)
    // A card moved twice ends in the column of its last move.
    if (at >= prev.last) {
      prev.last = at
      prev.where = safeText(row.where, 80) ?? prev.where
    }
  }
  const out = new Map<string, ActivityEffect[]>()
  for (const [runId, merged] of byRun) {
    out.set(runId, [...merged.entries()]
      .filter(([key, e]) => {
        const by = SHADOWED_BY[e.kind]
        return !by || !merged.has(`${by}:${key.slice(e.kind.length + 1)}`)
      })
      .map(([, e]) => e)
      .sort((a, b) => a.first - b.first)
      .map(({ first: _first, last: _last, ...effect }) => effect))
  }
  return out
}

/** tool.started and tool.finished rows in time order, paired by call id. */
function pairSteps(events: EventRow[], stepText: boolean): ActivityStep[] {
  const steps: ActivityStep[] = []
  const byCall = new Map<string, ActivityStep>()
  for (const e of events) {
    if (e.kind !== 'tool.started' && e.kind !== 'tool.finished') continue
    let step = e.callId ? byCall.get(e.callId) : undefined
    if (!step) {
      step = { name: e.name ?? 'tool', text: null, status: null, ok: null, durationMs: null }
      steps.push(step)
      if (e.callId) byCall.set(e.callId, step)
    }
    if (e.name) step.name = e.name
    if (e.kind === 'tool.finished') {
      step.ok = e.ok
      step.durationMs = e.durationMs
      step.text = stepText ? safeText(e.arg, 120) : null
      step.status = stepText ? safeText(e.status, 40) : null
    }
  }
  return steps
}

function problemsOf(run: RunRow, events: EventRow[], steps: ActivityStep[]): ActivityProblem[] {
  const out: ActivityProblem[] = []
  const seen = new Set<string>()
  // A run's error is usually also the text of its last error event (turn.failed,
  // engine.failed), so the same text shows once.
  const add = (p: ActivityProblem) => {
    const key = p.text ?? `${p.kind}:${p.title ?? ''}`
    if (seen.has(key) || out.length >= MAX_PROBLEMS) return
    seen.add(key)
    out.push(p)
  }
  const text = (raw: string | null) => (run.textVisible ? safeText(raw, 240) : null)
  // A rate-limited BYOA run fails with no error; its summary says why.
  if (run.status === 'failed') add({ kind: 'failed', title: null, text: text(run.error ?? run.summary) })
  if (run.status === 'stalled') add({ kind: 'stalled', title: null, text: null })
  for (const e of events) {
    if (e.level === 'error') add({ kind: 'error', title: safeText(e.title, 120), text: text(e.error) })
  }
  for (const s of steps) {
    if (s.ok === false) add({ kind: 'step', title: s.name, text: s.status })
  }
  return out
}

export function buildActivity(
  input: { runs: RunRow[]; effects: EffectRow[]; events: EventRow[]; routines: RoutineRow[] },
  viewer: { stepText: boolean },
): RoomActivity {
  const effects = groupEffects(input.effects)
  const events = new Map<string, EventRow[]>()
  for (const e of input.events) {
    const list = events.get(e.runId)
    if (list) list.push(e)
    else events.set(e.runId, [e])
  }
  return {
    runs: input.runs.map((run) => {
      const own = events.get(run.id) ?? []
      const steps = pairSteps(own, viewer.stepText)
      return {
        id: run.id,
        agentId: run.agentId,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        updatedAt: run.updatedAt.toISOString(),
        durationMs: run.durationMs,
        costUsd: run.costUsd,
        costEstimated: run.costEstimated,
        model: safeText(run.model, 80),
        summary: run.textVisible ? safeText(run.summary, 240) : null,
        effects: effects.get(run.id) ?? [],
        problems: problemsOf(run, own, steps),
        steps: steps.slice(0, MAX_STEPS),
        stepCount: steps.length,
      }
    }),
    routines: input.routines.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      at: r.at.toISOString(),
      title: safeText(r.title, 120),
      text: safeText(r.error, 240),
    })),
  }
}

/* ── Route ─────────────────────────────────────────────────────────── */

const RUN_LIMIT = 20
const ROUTINE_LIMIT = 10
// ponytail: only the room agents' newest CANDIDATE_LIMIT runs are checked
// against the room, which bounds the per-run EXISTS checks. A quiet room whose
// agents are busy elsewhere can then list fewer than RUN_LIMIT runs; record the
// room on the run (or index llm_calls by room) and filter first if that shows up.
const CANDIDATE_LIMIT = 400
const HISTORY = `INTERVAL '14 days'`
// Notices and the last reply land a moment after the engine returns.
const GRACE = `INTERVAL '30 seconds'`
// Same threshold as STALLED_INTERVAL in api/router.ts (the devtools runs list).
const STALLED = `INTERVAL '5 minutes'`
// realtime_outbox drops published rows after a day (COMPLETED_RETENTION_HOURS
// in realtime-outbox.ts), so card moves, card edits and deletions reach back
// no further than this.
const OUTBOX_MS = 24 * 3600_000

/** Same rule as calendarVisibilityClause in api/router.ts: private events show
 *  to their creator and assignee, and to the owner when an agent is on either side. */
function calendarVisible(e: string, viewer: string, company: string): string {
  return `(
    ${e}.is_private = false OR ${e}.created_by = ${viewer} OR ${e}.assignee_id = ${viewer}
    OR (
      EXISTS (SELECT 1 FROM companies WHERE id = ${company} AND owner_user_id = ${viewer})
      AND (
        ${e}.created_by IN (SELECT id FROM participants WHERE company_id = ${company} AND kind = 'agent')
        OR ${e}.assignee_id IN (SELECT id FROM participants WHERE company_id = ${company} AND kind = 'agent')
      )
    )
  )`
}

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** GET /api/fork/rooms/:conversationId/activity, for members of the room only. */
export async function roomActivity(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const room = String(req.params.conversationId)
  if (room.length > 100) { res.status(400).json({ error: 'conversationId must be at most 100 characters' }); return }
  // Imported here, not at the top: the tests import this module for its pure
  // functions, and db/pool.js loads env.ts, which exits without OPENAI_API_KEY.
  const { pool } = await import('../db/pool.js')

  const gate = await pool.query<{ member: boolean; role: string | null }>(
    `SELECT EXISTS (
              SELECT 1 FROM conversation_members cm
                JOIN conversations c ON c.id = cm.conversation_id AND c.company_id = cm.company_id
               WHERE cm.conversation_id = $1 AND cm.company_id = $2 AND cm.participant_id = $3
            ) AS member,
            (SELECT role FROM company_members WHERE company_id = $2 AND user_id = $3) AS role`,
    [room, companyId, userId],
  )
  // Same 404 as a room that does not exist, like requireConversationMember.
  if (!gate.rows[0]?.member) { res.status(404).json({ error: 'not found' }); return }
  // Step text is a command line that can quote any room, so only the people
  // who can already read every run (devtools: owner and admin) get it.
  const stepText = gate.rows[0].role === 'owner' || gate.rows[0].role === 'admin'

  const routines = () => pool.query<RoutineRow>(
    `SELECT d.id, e.assignee_id AS "agentId", d.dispatched_at AS at, e.title, d.error
       FROM calendar_dispatches d
       JOIN calendar_events e ON e.id = d.event_id
      WHERE d.company_id = $2 AND d.status = 'failed'
        AND d.dispatched_at > NOW() - ${HISTORY}
        -- A dispatch that failed before it found its room has no conversation_id.
        AND (d.conversation_id = $1 OR (d.conversation_id IS NULL AND e.target_conversation_id = $1))
        AND ${calendarVisible('e', '$3', '$2')}
      ORDER BY d.dispatched_at DESC
      LIMIT ${ROUTINE_LIMIT}`,
    [room, companyId, userId],
  ).then((r) => r.rows)

  const { rows: runs } = await pool.query<RunRow & { windowEnd: Date }>(
    `WITH room_agents AS (
       SELECT cm.participant_id AS id
         FROM conversation_members cm
         JOIN participants p ON p.id = cm.participant_id AND p.company_id = cm.company_id
        WHERE cm.conversation_id = $1 AND cm.company_id = $2 AND p.kind = 'agent'
     ), candidates AS (
       SELECT r.*, LEAD(r.started_at) OVER (PARTITION BY r.agent_id ORDER BY r.started_at) AS next_started_at
         FROM agent_runs r
        WHERE r.company_id = $2
          AND r.agent_id IN (SELECT id FROM room_agents)
          AND r.started_at > NOW() - ${HISTORY}
        ORDER BY r.started_at DESC
        LIMIT ${CANDIDATE_LIMIT}
     ), windowed AS (
       -- LEAST skips NULL, so the last run of an agent keeps its full grace.
       SELECT c.*, LEAST(COALESCE(c.finished_at, NOW()) + ${GRACE}, c.next_started_at) AS window_end
         FROM candidates c
     )
     SELECT w.id, w.agent_id AS "agentId",
            CASE WHEN w.status = 'running' AND w.updated_at < NOW() - ${STALLED} THEN 'stalled' ELSE w.status END AS status,
            w.summary, w.error,
            w.started_at AS "startedAt", w.updated_at AS "updatedAt", w.finished_at AS "finishedAt",
            w.window_end AS "windowEnd",
            ROUND(EXTRACT(EPOCH FROM (COALESCE(w.finished_at, NOW()) - w.started_at)) * 1000)::int AS "durationMs",
            w.cost_usd AS "costUsd", w.cost_estimated AS "costEstimated", w.model,
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(w.trigger->'conversationIds') = 'array'
                            THEN w.trigger->'conversationIds' ELSE '[]'::jsonb END) AS t(id)
               WHERE NOT EXISTS (
                 SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = t.id AND cm.company_id = $2 AND cm.participant_id = $3)
            ) AS "textVisible"
       FROM windowed w
      WHERE w.trigger->'conversationIds' @> jsonb_build_array($1::text)
         -- input_message_ids becomes {truncated, preview} when it was too big to store.
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(w.input_message_ids) = 'array'
                            THEN w.input_message_ids ELSE '[]'::jsonb END) AS x(id)
                JOIN messages m ON m.id = x.id
               WHERE m.conversation_id = $1)
         OR EXISTS (SELECT 1 FROM llm_calls l WHERE l.run_id = w.id AND l.conversation_id = $1)
         OR EXISTS (
              SELECT 1 FROM messages m
               WHERE m.conversation_id = $1 AND m.author_id = w.agent_id
                 AND m.created_at >= w.started_at AND m.created_at < w.window_end)
      ORDER BY w.started_at DESC
      LIMIT ${RUN_LIMIT}`,
    [room, companyId, userId],
  )

  if (runs.length === 0) {
    res.json(buildActivity({ runs, effects: [], events: [], routines: await routines() }, { stepText }))
    return
  }

  // One row per run: rows joined against it fall inside that run's window only.
  const windows = [
    runs.map((r) => r.id),
    runs.map((r) => r.agentId),
    runs.map((r) => r.startedAt.toISOString()),
    runs.map((r) => r.windowEnd.toISOString()),
  ]
  const W = 'unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[]) AS w(run_id, agent_id, lo, hi)'
  const scoped = [...windows, companyId]
  const latest = Math.max(...runs.map((r) => r.windowEnd.getTime()))
  const earliest = Math.min(...runs.map((r) => r.startedAt.getTime()))

  type Row = { runId: string; at: Date; target: string; title: string | null; where: string | null; boardId: string | null; cardId: string | null }
  const board = (kind: EffectKind) => (r: Row): EffectRow => ({
    runId: r.runId, kind, at: r.at, target: r.target, title: r.title, where: r.where, count: 1,
    ref: r.boardId ? { type: 'board', id: r.boardId, cardId: r.cardId } : null,
  })
  const doc = (kind: EffectKind) => (r: Row): EffectRow => ({
    runId: r.runId, kind, at: r.at, target: r.target, title: r.title, where: null, count: 1,
    ref: { type: 'doc', id: r.target },
  })
  type OutboxRow = {
    runId: string; at: Date; kind: string; boardId: string; cardId: string | null; documentId: string | null
    cardTitle: string | null; columnTitle: string | null; boardTitle: string | null; docTitle: string | null
  }
  // Rows whose card, column, board or doc is gone (or in another workspace)
  // have nothing left to name, except deletions, which name where they happened.
  const fromOutbox = (o: OutboxRow): EffectRow | null => {
    const base = { runId: o.runId, at: o.at, count: 1 }
    if (o.kind === 'document.updated' && o.documentId && o.docTitle !== null) {
      return { ...base, kind: 'doc.edited', target: o.documentId, title: o.docTitle, where: null, ref: { type: 'doc', id: o.documentId } }
    }
    if (o.kind === 'document.deleted' && o.documentId) {
      return { ...base, kind: 'doc.deleted', target: o.documentId, title: null, where: null, ref: null }
    }
    if (!o.cardId || o.boardTitle === null) return null
    if (o.kind === 'card.deleted') {
      return { ...base, kind: 'card.deleted', target: o.cardId, title: null, where: o.boardTitle, ref: { type: 'board', id: o.boardId, cardId: null } }
    }
    if (o.cardTitle === null) return null
    const ref: EffectRef = { type: 'board', id: o.boardId, cardId: o.cardId }
    if (o.kind === 'card.updated') return { ...base, kind: 'card.updated', target: o.cardId, title: o.cardTitle, where: o.boardTitle, ref }
    if (o.kind === 'card.moved' && o.columnTitle !== null) {
      return { ...base, kind: 'card.moved', target: o.cardId, title: o.cardTitle, where: o.columnTitle, ref }
    }
    return null
  }

  const [posts, cards, comments, boards, docs, docEdits, calendar, outbox, events, routineRows] = await Promise.all([
    // Messages in other rooms the viewer is in. This room's own replies are in the chat.
    pool.query<{ runId: string; conversationId: string; messageId: string; at: Date; count: number }>(
      `SELECT w.run_id AS "runId", m.conversation_id AS "conversationId", MIN(m.created_at) AS at,
              COUNT(*)::int AS count, (ARRAY_AGG(m.id ORDER BY m.created_at))[1] AS "messageId"
         FROM ${W}
         JOIN messages m ON m.company_id = $5 AND m.author_id = w.agent_id
                        AND m.created_at >= w.lo AND m.created_at < w.hi
        WHERE m.conversation_id <> $6
          AND m.kind IN ('text', 'attachment', 'poll', 'email')
          AND EXISTS (SELECT 1 FROM conversation_members cm
                       WHERE cm.conversation_id = m.conversation_id AND cm.company_id = $5 AND cm.participant_id = $7)
        GROUP BY w.run_id, m.conversation_id`,
      [...scoped, room, userId],
    ),
    // Boards, docs and non-private events are open to everyone in the workspace.
    pool.query<Row>(
      `SELECT w.run_id AS "runId", c.created_at AS at, c.id AS target, c.title, b.title AS "where",
              b.id AS "boardId", c.id AS "cardId"
         FROM ${W}
         JOIN board_cards c ON c.created_by = w.agent_id AND c.created_at >= w.lo AND c.created_at < w.hi
         JOIN boards b ON b.id = c.board_id AND b.company_id = $5`,
      scoped,
    ),
    pool.query<Row>(
      `SELECT w.run_id AS "runId", cc.created_at AS at, c.id AS target, c.title, b.title AS "where",
              b.id AS "boardId", c.id AS "cardId"
         FROM ${W}
         JOIN board_card_comments cc ON cc.author_id = w.agent_id AND cc.created_at >= w.lo AND cc.created_at < w.hi
         JOIN board_cards c ON c.id = cc.card_id
         JOIN boards b ON b.id = c.board_id AND b.company_id = $5`,
      scoped,
    ),
    pool.query<Row>(
      `SELECT w.run_id AS "runId", b.created_at AS at, b.id AS target, b.title, NULL AS "where",
              b.id AS "boardId", NULL AS "cardId"
         FROM ${W}
         JOIN boards b ON b.created_by = w.agent_id AND b.company_id = $5
                      AND b.created_at >= w.lo AND b.created_at < w.hi`,
      scoped,
    ),
    pool.query<Row>(
      `SELECT w.run_id AS "runId", d.created_at AS at, d.id AS target, d.title
         FROM ${W}
         JOIN documents d ON d.created_by = w.agent_id AND d.company_id = $5
                         AND d.created_at >= w.lo AND d.created_at < w.hi`,
      scoped,
    ),
    // Compaction deletes document_updates after 200 updates to a doc, so older
    // edits of busy docs are gone; the outbox below covers the last day.
    pool.query<Row>(
      `SELECT w.run_id AS "runId", MIN(du.created_at) AS at, d.id AS target, d.title
         FROM ${W}
         JOIN document_updates du ON du.author_id = w.agent_id AND du.created_at >= w.lo AND du.created_at < w.hi
         JOIN documents d ON d.id = du.document_id AND d.company_id = $5
        GROUP BY w.run_id, d.id, d.title`,
      scoped,
    ),
    pool.query<Row>(
      `SELECT w.run_id AS "runId", e.created_at AS at, e.id AS target, e.title
         FROM ${W}
         JOIN calendar_events e ON e.created_by = w.agent_id AND e.company_id = $5
                               AND e.created_at >= w.lo AND e.created_at < w.hi
        WHERE ${calendarVisible('e', '$6', '$5')}`,
      [...scoped, userId],
    ),
    // Card moves, card edits and deletions are recorded nowhere but the
    // realtime outbox: board_cards keeps no editor.
    latest < Date.now() - OUTBOX_MS
      ? Promise.resolve({ rows: [] as OutboxRow[] })
      : pool.query<OutboxRow>(
        `WITH o AS MATERIALIZED (
           -- 'cumora:boards' and 'cumora:docs' are CH_BOARDS and CH_DOCS in
           -- redis.ts, not imported because importing it connects to Redis.
           SELECT created_at, payload FROM realtime_outbox
            WHERE created_at >= $6 AND created_at < $7
              AND channel IN ('cumora:boards', 'cumora:docs')
              AND payload->>'companyId' = $5
              AND payload->>'kind' IN ('card.moved', 'card.updated', 'card.deleted', 'document.updated', 'document.deleted')
              AND payload->>'actorId' = ANY($2::text[])
         )
         SELECT w.run_id AS "runId", o.created_at AS at, o.payload->>'kind' AS kind,
                o.payload->>'boardId' AS "boardId", o.payload->>'cardId' AS "cardId",
                o.payload->>'documentId' AS "documentId",
                c.title AS "cardTitle", col.title AS "columnTitle", b.title AS "boardTitle", d.title AS "docTitle"
           FROM ${W}
           JOIN o ON o.payload->>'actorId' = w.agent_id AND o.created_at >= w.lo AND o.created_at < w.hi
           LEFT JOIN boards b ON b.id = o.payload->>'boardId' AND b.company_id = $5
           LEFT JOIN board_cards c ON c.id = o.payload->>'cardId' AND c.board_id = b.id
           LEFT JOIN board_columns col ON col.id = o.payload->>'columnId' AND col.board_id = b.id
           LEFT JOIN documents d ON d.id = o.payload->>'documentId' AND d.company_id = $5`,
        [...scoped, new Date(earliest).toISOString(), new Date(latest).toISOString()],
      ),
    // Only the fields shown are read: raw tool args and output never leave Postgres.
    pool.query<EventRow & { ok: string | null; durationMs: string | null }>(
      `SELECT run_id AS "runId", kind, level, title,
              data->>'callId' AS "callId",
              COALESCE(data->'display'->>'name', data->>'name') AS name,
              CASE WHEN kind = 'tool.finished' THEN data->'display'->>'arg' END AS arg,
              CASE WHEN kind = 'tool.finished' THEN data->'display'->>'status' END AS status,
              CASE WHEN kind = 'tool.finished' THEN data->>'ok' END AS ok,
              CASE WHEN kind = 'tool.finished' THEN data->>'durationMs' END AS "durationMs",
              CASE WHEN level = 'error' THEN left(data->>'error', 4000) END AS error
         FROM agent_events
        WHERE run_id = ANY($1::text[]) AND company_id = $2
          AND (kind IN ('tool.started', 'tool.finished') OR level = 'error')
        ORDER BY created_at, id`,
      [windows[0], companyId],
    ),
    routines(),
  ])

  const effects: EffectRow[] = [
    ...posts.rows.map((r): EffectRow => ({
      runId: r.runId, kind: 'message.posted', at: r.at, target: r.conversationId, title: null, where: null,
      count: r.count, ref: { type: 'room', id: r.conversationId, messageId: r.messageId },
    })),
    ...cards.rows.map(board('card.created')),
    ...comments.rows.map(board('comment.created')),
    ...boards.rows.map(board('board.created')),
    ...docs.rows.map(doc('doc.created')),
    ...docEdits.rows.map(doc('doc.edited')),
    ...calendar.rows.map((r): EffectRow => ({
      runId: r.runId, kind: 'event.created', at: r.at, target: r.target, title: r.title, where: null, count: 1,
      ref: { type: 'event', id: r.target },
    })),
    ...outbox.rows.map(fromOutbox).filter((e): e is EffectRow => e !== null),
  ]

  res.json(buildActivity({
    runs,
    effects,
    events: events.rows.map((e) => ({
      ...e,
      ok: e.ok === null ? null : e.ok === 'true',
      durationMs: e.durationMs === null || !Number.isFinite(Number(e.durationMs)) ? null : Number(e.durationMs),
    })),
    routines: routineRows,
  }, { stepText }))
}
