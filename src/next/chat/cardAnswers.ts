/**
 * Pure lookups over a room's cards, for the store in ./cards.ts: which
 * messages answered a card, which question a quote is about, and which
 * question the room's agent waits on. Free of runtime imports, so
 * tests/question-cards.test.ts runs them in node.
 */
import type { Card } from './cards'

/** A room's answer replies, by their id and their client id: the kind of card
 *  each answered and that card's question message. */
export type Answers = ReadonlyMap<string, { kind: Card['kind']; question: string }>

export const NO_ANSWERS: Answers = new Map()

/** The room's answer replies, from its cards. `prev` comes back while it holds
 *  the same replies, so the transcript does not rebuild its rows for a card
 *  that changed nothing there. */
export function roomAnswers(cards: Iterable<Card>, room: string, prev: Answers = NO_ANSWERS): Answers {
  const ids = new Map<string, { kind: Card['kind']; question: string }>()
  for (const c of cards) {
    if (c.conversationId !== room || !c.answer) continue
    const of = { kind: c.kind, question: c.messageId }
    ids.set(c.answer.clientId, of)
    if (c.answer.messageId) ids.set(c.answer.messageId, of)
  }
  return ids.size === prev.size && [...ids].every(([id, of]) => prev.get(id)?.question === of.question) ? prev : ids
}

/** The kind of card a message answered, if it is such a reply. Its client id
 *  is known before the reply is posted, so it is found from its first frame. */
export function answerKind(answers: Answers, m: { id: string; clientId?: string }): Card['kind'] | undefined {
  return (answers.get(m.id) ?? (m.clientId === undefined ? undefined : answers.get(m.clientId)))?.kind
}

/** The question card a quote is about: the question itself, or the reply that answered it. */
export function questionOf(byMessage: Record<string, Card>, answers: Answers, quotedId: string): Card | undefined {
  const reply = answers.get(quotedId)
  const card = byMessage[quotedId] ?? (reply ? byMessage[reply.question] : undefined)
  return card?.kind === 'choice' ? card : undefined
}

/** What a person tried to send when someone else answered first: the try
 *  that lost the race (`lost`), else what they were still typing. Never my
 *  own answer: the closed card reaches me before the server answers my POST,
 *  and by then it already names me as the one who answered. */
export function unsentAnswer(answeredBy: string, me: string | null, lost: string | null, draft: string): string | null {
  if (answeredBy === me) return null
  return lost ?? (draft.trim() || null)
}

/** What the room's agents wait for: of each agent's newest question in the
 *  room, the newest one nobody has answered. An agent that asked again has
 *  moved past its older questions, so one the room talked past keeps its card
 *  but no longer holds the pill. Left out are secret requests (one whose
 *  agent left the room can never be sent, so its pill would stay forever) and
 *  questions a person answered with a reply quoting them instead of through
 *  the card, from the classic UI, an older app or the composer: `quoted`
 *  holds what people's messages quote. */
export function waitingQuestion(cards: Iterable<Card>, room: string, quoted: ReadonlySet<string>): Card | undefined {
  // Per agent, not per room: one agent asking says nothing about another's question.
  const latest = new Map<string, Card>()
  for (const c of cards) {
    if (c.conversationId !== room || c.kind !== 'choice') continue
    const seen = latest.get(c.agentId)
    if (!seen || c.createdAt > seen.createdAt) latest.set(c.agentId, c)
  }
  let newest: Card | undefined
  for (const c of latest.values()) {
    if (c.answer || quoted.has(c.messageId)) continue
    if (!newest || c.createdAt > newest.createdAt) newest = c
  }
  return newest
}
