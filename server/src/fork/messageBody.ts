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

/** A person's message on one line: whole up to BODY_CAP, marked past it. */
export function humanLine(body: string): string {
  const cut = body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}${TRUNCATED}` : body
  return cut.replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, ' \\n ').trim()
}

/** The wake digest rides in the prompt, which some engines pass as one argv
 *  string (Claude's one-shot fallback, Grok, Cursor, pi; Linux caps one at
 *  128 KiB, and an E2BIG skips the ack so the same digest fails again). Whole
 *  bodies of people's messages share this budget, newest first. 8000 chars is
 *  at most ~24 KiB of Korean on top of the 40 lines of 600 upstream allows. */
export const DIGEST_HUMAN_CHARS = 8000
const DIGEST_PREVIEW = 600

/** Ids of the people's messages the digest shows whole. Rows are created_at
 *  ASC; one that fits the preview costs nothing, and one that would overrun
 *  the budget is skipped so an older, shorter one can still fit. */
export function wholeInDigest(
  rows: ReadonlyArray<{ id?: unknown; kind?: unknown; author_kind?: unknown; body?: unknown }>,
): Set<unknown> {
  const whole = new Set<unknown>()
  let left = DIGEST_HUMAN_CHARS
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind === 'system' || r.author_kind !== 'human' || typeof r.body !== 'string') continue
    if (r.body.length <= DIGEST_PREVIEW) continue
    const cost = Math.min(r.body.length, BODY_CAP)
    if (cost > left) continue
    whole.add(r.id)
    left -= cost
  }
  return whole
}

/** A person's message in the digest: whole when wholeInDigest picked it,
 *  otherwise the preview, marked, with the command that reads all of it. */
export function digestHumanBody(body: string, whole: boolean, convoId: string): string {
  if (whole || body.length <= DIGEST_PREVIEW) return humanLine(body)
  return `${humanLine(body.slice(0, DIGEST_PREVIEW))}${TRUNCATED} read it whole: \`cumora messages ${convoId}\``
}
