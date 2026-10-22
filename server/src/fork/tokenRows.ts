/**
 * The marks the computer's daemon puts on `llm_calls.extras` for the chat's
 * developer token figures: agents/computer/daemon.ts writes them and
 * fork/tokens.ts reads them. Raise TOKEN_ACCT when a row's meaning changes;
 * rows written before then stop showing.
 */
export const TOKEN_ACCT = 2
/** On an agenda turn's rows: proactive work that answers no room. */
export const AGENDA_MARK = 'agenda'
