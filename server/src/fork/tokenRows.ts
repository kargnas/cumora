/**
 * The marks the computer's daemon puts on `llm_calls.extras` for the chat's
 * developer token figures: agents/computer/daemon.ts writes them through
 * tokenMarks, fork/tokens.ts reads them, and agents/llm-rollup.ts leaves
 * `rest` rows out of its call counts. Raise TOKEN_ACCT when a row's meaning
 * changes; rows written before then stop showing.
 */
export const TOKEN_ACCT = 2
/** On an agenda turn's rows: proactive work that answers no room. */
export const AGENDA_MARK = 'agenda'
/** On a turn's rest row: usage its calls left out, which is no call itself. */
export const REST_MARK = 'rest'

/** The extras for one hop the engine reported. Only a hop whose usage matches
 *  the engine's own record (persistent Claude and Codex sessions) is marked
 *  for the figures; an agenda turn's hops are marked as such either way. */
export function tokenMarks(hop: { exact?: true; window?: number; sub?: string; rest?: unknown }, agenda: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (hop.exact) {
    out.acct = TOKEN_ACCT
    if (hop.window) out.window = hop.window
    if (hop.sub) out.sub = hop.sub
    if (hop.rest) out[REST_MARK] = hop.rest
  }
  if (agenda) out[AGENDA_MARK] = true
  return out
}
