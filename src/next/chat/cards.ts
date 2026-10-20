/**
 * Cards under agents' messages: a question with options, or a request for a
 * secret (server/src/fork/cards.ts). A room's cards load with its transcript,
 * which waits for them on its first load so a card never pops in under
 * history, and change through the `fork.card` event. A person's answer is
 * their reply quoting the question; the card shows it, so the transcript
 * hides that reply (`hidden`). The server sends the closed card before it
 * posts the reply, so the reply is hidden from its first frame.
 */
import { create } from 'zustand'
import { ApiError, http, ws } from '@/api/client'
import { useAuth } from '@/stores/auth'

export interface CardAnswer {
  by: string
  at: string
  /** The option's index; null for a secret. */
  option: number | null
  clientId: string
  messageId: string | null
}

export interface Card {
  messageId: string
  conversationId: string
  agentId: string
  kind: 'choice' | 'secret'
  question: string
  options: string[]
  createdAt: string
  answer: CardAnswer | null
  takenAt: string | null
  expiresAt: string | null
  /** Bumped by every change on the server; the higher one is the newer copy. */
  rev: number
}

const NONE: ReadonlySet<string> = new Set()

interface State {
  byMessage: Record<string, Card>
  /** Rooms whose cards loaded. */
  loaded: Record<string, true>
  /** Rooms whose load finished, even by failing: a transcript waits for this,
   *  never forever. A failed room loads again the next time it opens. */
  ready: Record<string, true>
  /** Per room, the ids and client ids of the replies that answered its cards. */
  hidden: Record<string, ReadonlySet<string>>
  load: (conversationId: string) => Promise<void>
  answer: (card: Card, option: number) => Promise<void>
  sendSecret: (card: Card, value: string) => Promise<void>
}

/** Adds the cards the server sent, keeping the newer copy of each by its
 *  `rev`: a load's snapshot or an answer's response can arrive after a later
 *  change came through `fork.card`. ponytail: cards are only ever added, so
 *  a purged agent's cards stay until the page reloads. A room's hidden set
 *  keeps its identity while it holds the same ids, so the transcript does not
 *  rebuild its rows for a card that changed nothing there. */
function put(s: State, cards: Card[]): Partial<State> {
  const byMessage = { ...s.byMessage }
  const rooms = new Set<string>()
  for (const c of cards) {
    if ((byMessage[c.messageId]?.rev ?? -1) > c.rev) continue
    byMessage[c.messageId] = c
    rooms.add(c.conversationId)
  }
  const hidden = { ...s.hidden }
  for (const r of rooms) {
    const ids = new Set<string>()
    for (const c of Object.values(byMessage)) {
      if (c.conversationId !== r || !c.answer) continue
      ids.add(c.answer.clientId)
      if (c.answer.messageId) ids.add(c.answer.messageId)
    }
    const prev = s.hidden[r] ?? NONE
    if (ids.size !== prev.size || [...ids].some((id) => !prev.has(id))) hidden[r] = ids
  }
  return { byMessage, hidden }
}

export const useCards = create<State>((set, get) => {
  useAuth.subscribe((s, prev) => {
    if (s.contextEpoch !== prev.contextEpoch) set({ byMessage: {}, loaded: {}, ready: {}, hidden: {} })
  })
  // A fork event, outside the client's event union. After a reconnect the
  // rooms already shown load again, since events sent meanwhile are lost.
  ws.on((e) => {
    const ev = e as { type: string; card?: Card }
    if (ev.type === 'fork.card' && ev.card) set((s) => put(s, [ev.card as Card]))
    else if (ev.type === 'hello') for (const room of Object.keys(get().ready)) void get().load(room)
  })

  /** Applies the card the server answers with. When someone answered first
   *  (409), the room loads again, in case its `fork.card` was missed. */
  async function post(card: Card, action: 'answer' | 'secret', body: unknown): Promise<void> {
    try {
      const res = await http<{ card: Card }>(`/fork/cards/${encodeURIComponent(card.messageId)}/${action}`, {
        method: 'POST', body: JSON.stringify(body),
      })
      set((s) => put(s, [res.card]))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) void get().load(card.conversationId)
      throw e
    }
  }

  return {
    byMessage: {},
    loaded: {},
    ready: {},
    hidden: {},

    async load(conversationId) {
      const epoch = useAuth.getState().contextEpoch
      try {
        const { cards } = await http<{ cards: Card[] }>(`/fork/cards?conversation=${encodeURIComponent(conversationId)}`)
        if (useAuth.getState().contextEpoch !== epoch) return
        set((s) => ({
          ...put(s, cards),
          loaded: { ...s.loaded, [conversationId]: true },
          ready: { ...s.ready, [conversationId]: true },
        }))
      } catch (e) {
        if (useAuth.getState().contextEpoch !== epoch) return
        console.warn('[next] cards load failed', e)
        set((s) => ({ ready: { ...s.ready, [conversationId]: true } }))
      }
    },

    answer: (card, option) => post(card, 'answer', { option }),
    sendSecret: (card, value) => post(card, 'secret', { value }),
  }
})

/** The room's answer replies, for the transcript and threads to leave out. */
export function useHiddenAnswers(conversationId: string): ReadonlySet<string> {
  return useCards((s) => s.hidden[conversationId] ?? NONE)
}

/** Whether a message is a reply that answered a card, which the card shows. */
export function answersCard(hidden: ReadonlySet<string>, m: { id: string; clientId?: string }): boolean {
  return hidden.has(m.id) || (m.clientId !== undefined && hidden.has(m.clientId))
}
