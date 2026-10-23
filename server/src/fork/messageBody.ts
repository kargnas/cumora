/**
 * How much of a message body an agent reads in its wake digest
 * (agents/computer/daemon.ts) and in `cumora messages` (agents/cli.ts).
 *
 * Upstream cuts every body to a short preview there, 600 and 280 chars, with no
 * mark. A person's message is usually an instruction, often a pasted checklist,
 * and the digest tells the agent not to re-read what it shows, so the tail was
 * lost: a 1,481-char setup message reached its agent without its last four
 * questions. A person's message is therefore shown whole up to the 4096 chars
 * steer.ts already allows a mid-turn message, and marked like steer.ts marks it
 * when cut there. Agent and system rows keep each surface's preview. Runs in
 * the daemon bundle too, so it imports nothing.
 */

export const HUMAN_BODY_CHARS = 4096

export function agentVisibleBody(body: string, authorKind: unknown, previewChars: number): string {
  if (authorKind !== 'human') return body.slice(0, previewChars)
  return body.length > HUMAN_BODY_CHARS ? `${body.slice(0, HUMAN_BODY_CHARS)}... [truncated]` : body
}
