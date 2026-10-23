/**
 * How an agent is shown a person's message on the surfaces that count it as
 * read: the wake digest and a mid-turn steer note (agents/computer/daemon.ts),
 * and `cumora messages`, `inbox`, `glance` and a held reply's envelope
 * (agents/cli.ts).
 *
 * Upstream cuts every body there to a short preview (600, 300, 280, 240 and
 * 200 chars) with no mark. A person's message is usually an instruction, often
 * a pasted checklist, and the digest tells the agent not to re-read what it
 * shows, so the tail was lost: a 1,481-char setup message reached its agent
 * without its last four questions. A person's message is therefore shown up to
 * BODY_CAP, marked when cut there, with its line breaks kept as ` \n `. Agent
 * and system rows keep each surface's upstream preview. Runs in the daemon
 * bundle too, so it imports nothing.
 */

/** Longest body an agent is handed in one piece. steer.ts caps a mid-turn
 *  message with the same value and mark. */
export const BODY_CAP = 4096
export const TRUNCATED = '... [truncated]'

/** Whether a row is a person's own text. A system row (a membership notice,
 *  say) names the person who acted as its author, so it does not count. */
export function isHumanText(row: { kind?: unknown; author_kind?: unknown }): boolean {
  return row.kind !== 'system' && row.author_kind === 'human'
}

/** A person's message on one line: whole up to BODY_CAP, marked past it. */
export function humanLine(body: string): string {
  const cut = body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}${TRUNCATED}` : body
  return cut.replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, ' \\n ').trim()
}

/** The wake digest rides in the prompt, which some engines pass as one argv
 *  string (Claude's one-shot fallback, Grok, Cursor, pi; Linux caps one at
 *  128 KiB, and an E2BIG skips the ack so the same digest fails again). The
 *  rendered lines of people's messages longer than the preview share this
 *  budget, so the digest grows by at most 8000 chars (~24 KiB of Korean) over
 *  the 40 lines of 600 upstream allows, plus the short hint on a line that
 *  falls back to its preview. */
export const DIGEST_HUMAN_CHARS = 8000
const DIGEST_PREVIEW = 600

/** Ids of the people's messages the digest shows whole. Rows are created_at
 *  ASC and `keep` is digestKeep's lines per conversation (daemon.ts), so the
 *  budget goes newest first to lines the digest prints, never to ones it drops.
 *  A line that fits the preview costs nothing; one that would overrun the
 *  budget is skipped so an older, shorter one can still fit. */
export function wholeInDigest(
  rows: ReadonlyArray<{ id?: unknown; conversation_id?: unknown; kind?: unknown; author_kind?: unknown; body?: unknown }>,
  keep: ReadonlyMap<string, number>,
): Set<unknown> {
  const whole = new Set<unknown>()
  const seen = new Map<unknown, number>()
  let left = DIGEST_HUMAN_CHARS
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    const nth = (seen.get(r.conversation_id) ?? 0) + 1
    seen.set(r.conversation_id, nth)
    if (typeof r.conversation_id !== 'string' || nth > (keep.get(r.conversation_id) ?? 0)) continue
    if (!isHumanText(r) || typeof r.body !== 'string') continue
    const cost = humanLine(r.body).length
    if (cost <= DIGEST_PREVIEW || cost > left) continue
    whole.add(r.id)
    left -= cost
  }
  return whole
}

/** A person's message in the digest: whole when wholeInDigest picked it,
 *  otherwise the preview, marked, with the command that reads all of it.
 *  `unread` is the conversation's unread count, so `--tail` reaches back to it
 *  (cumora messages shows the last 20 by default). */
export function digestHumanBody(body: string, whole: boolean, convoId: string, unread: number): string {
  const line = humanLine(body)
  if (whole || line.length <= DIGEST_PREVIEW) return line
  return `${line.slice(0, DIGEST_PREVIEW)}${TRUNCATED} read it whole: \`cumora messages ${convoId} --tail ${unread}\``
}
