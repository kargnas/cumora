/**
 * The Handbook: one agent's standing files compiled into one document (its
 * CLAUDE.md or AGENTS.md, its memory with MEMORY.md first, its own skills,
 * then the skills every agent on the computer shares), with what changed
 * since a time marked as tracked changes. Each change is a version the
 * recorder (./recorder.ts) stored. It belongs to the run the agent was in when
 * the file changed, and to the person's message that most likely started that
 * run.
 *
 * Owners and admins only: an agent's files can quote any room. A person's
 * message shows only to members of the room it was said in.
 */
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import { commonPairs, diffWords, type Seg } from './diff.js'
import { preview, redact } from './redact.js'
import { AGENT_ID, SHARED, computerMounted } from './recorder.js'
import { getForkStore, type FileVersion } from './store.js'

export type SectionKey = 'instructions' | 'memory' | 'skills'

export type ChangedLine = { op: 'del' | 'ins'; text: string } | { op: 'edit'; segs: Seg[] }

/** A run of unchanged lines, or the lines one change touched in one place. */
export type Part = { same: string[] } | { change: number; lines: ChangedLine[] }

export interface HandbookFile {
  /** Stable across requests. */
  key: string
  /** As the agent sees it: relative to its home, or under ~/.agents/skills. */
  path: string
  shared: boolean
  state: 'same' | 'changed' | 'created' | 'deleted'
  parts: Part[]
}

export interface Instruction {
  authorId: string
  at: string
  /** False when the viewer is not in the room it was said in: no room, no text. */
  visible: boolean
  conversationId: string | null
  messageId: string | null
  text: string | null
}

export interface HandbookChange {
  /** 1 for the oldest change after `since`. */
  n: number
  at: string
  path: string
  kind: 'created' | 'edited' | 'deleted'
  /** The agent whose run was open when the file changed; null when none was. */
  agentId: string | null
  instruction: Instruction | null
}

export type Attribution = Pick<HandbookChange, 'agentId' | 'instruction'>

export type Handbook =
  | { available: false }
  | { available: true; sections: Array<{ key: SectionKey; files: HandbookFile[] }>; changes: HandbookChange[] }

/* ── Document ──────────────────────────────────────────────────────── */

const SECTIONS: SectionKey[] = ['instructions', 'memory', 'skills']

/** Where a recorded file goes. `order` sorts it inside its section: MEMORY.md
 *  first, an agent's own skills before the shared ones, skills by name (the
 *  NUL ends a name, so "caveman" sorts before "caveman-commit"). */
function placeOf(scope: string, path: string): { section: SectionKey; path: string; order: string } | null {
  if (scope === SHARED) return { section: 'skills', path: `~/.agents/skills/${path}`, order: `1${path.split('/')[0]}\0` }
  if (path === 'CLAUDE.md' || path === 'AGENTS.md') return { section: 'instructions', path, order: path }
  if (path === 'memory/MEMORY.md') return { section: 'memory', path, order: '' }
  if (path.startsWith('memory/')) return { section: 'memory', path, order: path }
  if (path.startsWith('.claude/skills/')) return { section: 'skills', path, order: `0${path.split('/')[2]}\0` }
  return null
}

/** Lines redacted one by one, so a pattern never joins two lines and the
 *  line count stays what the diff compares. */
function linesOf(content: string | null): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(redact)
}

type Origin = { base: number } | { by: number }

/**
 * Plays a file's versions forward from `base`, keeping for every line of the
 * result where it came from: a line of `base`, or the version that added it.
 * Lines of `base` that a version removed remember that version. Composing the
 * diffs of consecutive versions, rather than diffing `base` against the result
 * once, is what ties each mark to the change that made it.
 */
function track(base: string[], steps: Array<{ id: number; lines: string[] }>) {
  let lines = base
  let origin: Origin[] = base.map((_, i) => ({ base: i }))
  const removedBy: number[] = new Array(base.length).fill(0)
  for (const step of steps) {
    const next: Origin[] = step.lines.map(() => ({ by: step.id }))
    const kept = new Uint8Array(lines.length)
    for (const [i, j] of commonPairs(lines, step.lines)) {
      next[j] = origin[i]
      kept[i] = 1
    }
    origin.forEach((o, i) => { if (!kept[i] && 'base' in o) removedBy[o.base] = step.id })
    lines = step.lines
    origin = next
  }
  return { lines, origin, removedBy }
}

type Marked = { text: string; by: number }

/**
 * The changed lines between two kept lines, grouped into one block per change
 * where neighbours share one. A change's removals pair with its additions in
 * order, as word edits where the two lines read as one line rewritten; an edit
 * sits where its new line is, and the rest go as a diff reads, removals
 * before additions, with additions in their order in the file.
 */
function gapBlocks(removed: Marked[], added: Marked[]): Array<{ by: number; lines: ChangedLine[] }> {
  const byChange = new Map<number, { r: number[]; a: number[] }>()
  const of = (by: number) => {
    let entry = byChange.get(by)
    if (!entry) byChange.set(by, (entry = { r: [], a: [] }))
    return entry
  }
  removed.forEach((l, i) => { of(l.by).r.push(i) })
  added.forEach((l, i) => { of(l.by).a.push(i) })
  const edits = new Map<number, { r: number; segs: Seg[] }>()
  const paired = new Set<number>()
  for (const { r, a } of byChange.values()) {
    for (let x = 0; x < Math.min(r.length, a.length); x++) {
      const segs = diffWords(removed[r[x]].text, added[a[x]].text)
      if (segs) {
        edits.set(a[x], { r: r[x], segs })
        paired.add(r[x])
      }
    }
  }

  const blocks: Array<{ by: number; lines: ChangedLine[] }> = []
  const push = (by: number, line: ChangedLine) => {
    const last = blocks[blocks.length - 1]
    if (last?.by === by) last.lines.push(line)
    else blocks.push({ by, lines: [line] })
  }
  let ri = 0
  const removeUntil = (end: number) => {
    for (; ri < end; ri++) if (!paired.has(ri)) push(removed[ri].by, { op: 'del', text: removed[ri].text })
  }
  let pending: Marked[] = []
  const addPending = () => {
    for (const l of pending) push(l.by, { op: 'ins', text: l.text })
    pending = []
  }
  added.forEach((l, ai) => {
    const edit = edits.get(ai)
    if (!edit) {
      pending.push(l)
      return
    }
    removeUntil(edit.r)
    addPending()
    push(l.by, { op: 'edit', segs: edit.segs })
  })
  removeUntil(removed.length)
  addPending()
  return blocks
}

function partsOf(base: string[], t: ReturnType<typeof track>, numberOf: (id: number) => number): Part[] {
  const parts: Part[] = []
  let same: string[] = []
  let removed: Marked[] = []
  let added: Marked[] = []
  let b = 0
  const flush = () => {
    const blocks = gapBlocks(removed, added)
    removed = []
    added = []
    if (blocks.length === 0) return
    if (same.length) parts.push({ same })
    same = []
    for (const block of blocks) parts.push({ change: numberOf(block.by), lines: block.lines })
  }
  t.lines.forEach((text, j) => {
    const o = t.origin[j]
    if ('by' in o) {
      added.push({ text, by: o.by })
      return
    }
    // Kept lines keep their order, so every base line before this one that
    // is not kept was removed by some version.
    for (; b < o.base; b++) removed.push({ text: base[b], by: t.removedBy[b] })
    b = o.base + 1
    flush()
    same.push(text)
  })
  for (; b < base.length; b++) removed.push({ text: base[b], by: t.removedBy[b] })
  flush()
  if (same.length) parts.push({ same })
  return parts
}

interface History { scope: string; path: string; base: FileVersion | null; changes: FileVersion[]; all: FileVersion[] }

/** Versions as FileStore.fileVersions returns them (by file, then time). The
 *  base is the text a file had at `since`: its newest version at or before
 *  it, or, for a file first seen later, the baseline it was first seen with,
 *  the oldest text known. A baseline is never a change. */
function histories(versions: FileVersion[], since: string | null): History[] {
  const out: History[] = []
  for (const v of versions) {
    const last = out[out.length - 1]
    if (last?.scope === v.scope && last.path === v.path) last.all.push(v)
    else out.push({ scope: v.scope, path: v.path, base: null, changes: [], all: [v] })
  }
  for (const h of out) {
    const before = since === null ? [] : h.all.filter((v) => v.at <= since)
    const after = since === null ? h.all : h.all.filter((v) => v.at > since)
    h.base = before[before.length - 1] ?? (after[0]?.baseline ? after[0] : null)
    h.changes = after.filter((v) => !v.baseline)
  }
  return out
}

/** Every change after `since`, oldest first; `n` numbers them from 1. */
function listChanges(versions: FileVersion[], since: string | null): Array<FileVersion & { n: number; kind: HandbookChange['kind'] }> {
  const out: Array<FileVersion & { kind: HandbookChange['kind'] }> = []
  for (const h of histories(versions, since)) {
    for (const v of h.changes) {
      const prev = h.all[h.all.indexOf(v) - 1]
      out.push({ ...v, kind: v.content === null ? 'deleted' : !prev || prev.content === null ? 'created' : 'edited' })
    }
  }
  return out
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
    .map((v, i) => ({ ...v, n: i + 1 }))
}

/**
 * The document as of `at` (null: now), with every change after `since` (null:
 * all time) up to `at` marked. `changes` lists every change after `since`,
 * those after `at` included, so the scrubber can reach them.
 */
export function buildHandbook(
  versions: FileVersion[],
  range: { since: string | null; at: string | null },
  attribution: ReadonlyMap<number, Attribution>,
): Handbook {
  const { since } = range
  const at = range.at !== null && since !== null && range.at < since ? since : range.at
  const changes = listChanges(versions, since)
  const numbers = new Map(changes.map((c) => [c.id, c.n]))
  const numberOf = (id: number) => numbers.get(id) ?? 0

  const files: Array<HandbookFile & { section: SectionKey; order: string }> = []
  for (const h of histories(versions, since)) {
    const place = placeOf(h.scope, h.path)
    if (!place) continue
    const steps = at === null ? h.changes : h.changes.filter((v) => v.at <= at)
    const startText = h.base?.content ?? null
    const endText = steps.length ? steps[steps.length - 1].content : startText
    if (startText === null && endText === null) continue
    const base = linesOf(startText)
    const tracked = track(base, steps.map((v) => ({ id: v.id, lines: linesOf(v.content) })))
    const parts = partsOf(base, tracked, numberOf)
    files.push({
      key: `${h.scope || 'shared'}:${h.path}`,
      path: place.path,
      shared: h.scope === SHARED,
      state: startText === null ? 'created' : endText === null ? 'deleted' : parts.some((p) => 'change' in p) ? 'changed' : 'same',
      parts,
      section: place.section,
      order: place.order,
    })
  }

  return {
    available: true,
    sections: SECTIONS
      .map((key) => ({
        key,
        files: files
          .filter((f) => f.section === key)
          .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
          .map(({ section: _section, order: _order, ...f }) => f),
      }))
      .filter((s) => s.files.length > 0),
    changes: changes.map((c) => ({
      n: c.n,
      at: c.at,
      path: placeOf(c.scope, c.path)?.path ?? c.path,
      kind: c.kind,
      agentId: attribution.get(c.id)?.agentId ?? null,
      instruction: attribution.get(c.id)?.instruction ?? null,
    })),
  }
}

/* ── Route ─────────────────────────────────────────────────────────── */

// Notices and the last reply land a moment after the engine returns.
const GRACE = `INTERVAL '30 seconds'`
// Same threshold as STALLED_INTERVAL in api/router.ts: a run that reported
// nothing for this long is not open any more, whatever its status says.
const STALLED = `INTERVAL '5 minutes'`
const INSTRUCTION_CHARS = 280
const PRIVILEGED = new Set(['owner', 'admin'])

type Pool = (typeof import('../db/pool.js'))['pool']

interface AttributionRow {
  key: string
  agentId: string
  messageId: string | null
  conversationId: string | null
  authorId: string | null
  askedAt: Date | null
  visible: boolean | null
  body: string | null
}

/**
 * Who caused each change. A change at T belongs to the run of the agent that
 * was open at T: from its start to its end plus GRACE (a run still going is
 * open until now). A shared skill can change in any agent's run on the
 * computer, so for those every agent with a home there is a candidate, and
 * the run that started last wins.
 *
 * The instruction is the newest message a person wrote before that run
 * started, in a room the agent posted in during the run (BYOA runs record no
 * room, so the replies say where it worked), or in its 1:1 rooms when it
 * posted nowhere. Only messages after the agent's previous run started
 * count: an older one was already that run's to answer, so a run a routine
 * started does not take the last thing someone said.
 */
async function attribute(
  pool: Pool,
  changes: Array<FileVersion & { n: number }>,
  ctx: { agentId: string; companyId: string; userId: string; homes: string[] },
): Promise<Map<number, Attribution>> {
  if (changes.length === 0) return new Map()
  const { rows } = await pool.query<AttributionRow>(
    `WITH t AS (
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::boolean[]) AS t(key, at, shared)
     ), hit AS (
       SELECT DISTINCT ON (t.key) t.key, r.id AS run_id, r.agent_id, r.started_at, r.window_end
         FROM t
         CROSS JOIN LATERAL unnest(CASE WHEN t.shared THEN $4::text[] ELSE ARRAY[$5::text] END) AS a(id)
         CROSS JOIN LATERAL (
           SELECT r.id, r.agent_id, r.started_at,
                  COALESCE(r.finished_at,
                           CASE WHEN r.updated_at > NOW() - ${STALLED} THEN NOW() ELSE r.updated_at END) + ${GRACE} AS window_end
             FROM agent_runs r
            WHERE r.agent_id = a.id AND r.company_id = $6 AND r.started_at <= t.at
            ORDER BY r.started_at DESC
            LIMIT 1
         ) r
        WHERE r.window_end >= t.at
        ORDER BY t.key, r.started_at DESC
     ), runs AS (
       SELECT DISTINCT run_id, agent_id, started_at, window_end FROM hit
     ), asked AS (
       SELECT runs.run_id, m.*
         FROM runs
         CROSS JOIN LATERAL (
           SELECT ARRAY(
                    SELECT DISTINCT p.conversation_id FROM messages p
                     WHERE p.company_id = $6 AND p.author_id = runs.agent_id
                       AND p.created_at >= runs.started_at AND p.created_at < runs.window_end
                  ) AS rooms,
                  (SELECT MAX(prev.started_at) FROM agent_runs prev
                    WHERE prev.agent_id = runs.agent_id AND prev.company_id = $6
                      AND prev.started_at < runs.started_at) AS prev_start
         ) ctx
         CROSS JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.author_id, m.created_at, m.body
             FROM messages m
             JOIN participants h ON h.id = m.author_id AND h.company_id = m.company_id AND h.kind <> 'agent'
            WHERE m.company_id = $6
              AND m.kind IN ('text', 'attachment', 'poll', 'email')
              AND m.created_at < runs.started_at
              AND (ctx.prev_start IS NULL OR m.created_at > ctx.prev_start)
              AND m.conversation_id = ANY(
                    CASE WHEN cardinality(ctx.rooms) > 0 THEN ctx.rooms
                         ELSE ARRAY(
                                SELECT c.id FROM conversations c
                                  JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.company_id = c.company_id
                                 WHERE c.company_id = $6 AND c.kind = 'direct' AND cm.participant_id = runs.agent_id)
                    END)
            ORDER BY m.created_at DESC
            LIMIT 1
         ) m
     )
     SELECT hit.key, hit.agent_id AS "agentId",
            asked.id AS "messageId", asked.conversation_id AS "conversationId",
            asked.author_id AS "authorId", asked.created_at AS "askedAt", seen.visible,
            CASE WHEN seen.visible THEN asked.body END AS body
       FROM hit
       LEFT JOIN asked ON asked.run_id = hit.run_id
       LEFT JOIN LATERAL (
         SELECT EXISTS (
                  SELECT 1 FROM conversation_members cm
                   WHERE cm.conversation_id = asked.conversation_id AND cm.company_id = $6 AND cm.participant_id = $7
                ) AS visible
       ) seen ON asked.id IS NOT NULL`,
    [
      changes.map((c) => String(c.id)),
      changes.map((c) => c.at),
      changes.map((c) => c.scope === SHARED),
      ctx.homes,
      ctx.agentId,
      ctx.companyId,
      ctx.userId,
    ],
  )
  return new Map(rows.map((r): [number, Attribution] => [Number(r.key), {
    agentId: r.agentId,
    instruction: r.messageId && r.authorId && r.askedAt
      ? {
        authorId: r.authorId,
        at: r.askedAt.toISOString(),
        visible: r.visible === true,
        conversationId: r.visible ? r.conversationId : null,
        messageId: r.visible ? r.messageId : null,
        text: r.visible ? preview(r.body, INSTRUCTION_CHARS) : null,
      }
      : null,
  }]))
}

function timeParam(raw: unknown): string | null | undefined {
  if (raw === undefined) return null
  if (typeof raw !== 'string') return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** GET /api/fork/agents/:agentId/handbook?since=<iso>&at=<iso>, for workspace
 *  owners and admins. No `since`: all time; no `at`: now. */
export async function agentHandbook(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const since = timeParam(req.query.since)
  const at = timeParam(req.query.at)
  if (since === undefined || at === undefined) {
    res.status(400).json({ error: 'since and at must be ISO times' })
    return
  }
  const agentId = String(req.params.agentId)
  // Imported here, not at the top: the tests import this module for its pure
  // functions, and db/pool.js loads env.ts, which exits without OPENAI_API_KEY.
  const { pool } = await import('../db/pool.js')
  const gate = await pool.query<{ role: string | null; agent: boolean }>(
    `SELECT (SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM participants WHERE id = $3 AND company_id = $1 AND kind = 'agent') AS agent`,
    [companyId, userId, agentId],
  )
  if (!PRIVILEGED.has(gate.rows[0]?.role ?? '')) {
    res.status(403).json({ error: 'only workspace owners and admins can read a handbook' })
    return
  }
  if (!gate.rows[0].agent || !AGENT_ID.test(agentId)) {
    res.status(404).json({ error: 'not found' })
    return
  }
  if (!computerMounted()) {
    res.json({ available: false } satisfies Handbook)
    return
  }

  const store = await getForkStore()
  const homes = store.fileScopes()
  // The shared skills belong to this computer: only an agent with a home
  // here reads them.
  const versions = homes.includes(agentId) ? store.fileVersions([agentId, SHARED], since) : []
  const attribution = await attribute(pool, listChanges(versions, since), { agentId, companyId, userId, homes })
  // The body only changes with the files and the runs, so Express's ETag
  // turns the client's poll into a 304 while nothing happens.
  // ponytail: every poll rebuilds the document, about 30 ms for 4,500 lines
  // of standing files; cache it by the newest version id if polls pile up.
  res.json(buildHandbook(versions, { since, at }, attribution))
}
