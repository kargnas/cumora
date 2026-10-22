/**
 * Developer token figures in a room, shown while developer mode is on (owners
 * and admins). Under each of my messages: the context of the latest agent call
 * and the cache hit ratio of every agent call from that message to my next one,
 * or to now. A 1:1 room's agent's agenda turns, which answer no room, show as
 * cards after the message they followed. The calls come from
 * GET /api/fork/rooms/:id/tokens (server/src/fork/tokens.ts), and
 * tokenSpans.ts places them.
 */
import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { ApiError, http } from '@/api/client'
import { useDevtools } from '@/stores/devtools'
import type { Item } from './model'
import { type AgendaCard, type Call, type Figures, type Mark, place } from './tokenSpans'

const POLL_MS = 10_000

interface Loaded { calls: Call[]; agenda: Call[]; cut: string | null }

interface TokensState {
  /** The server's last answer per room. */
  rooms: Record<string, Loaded>
  byMessage: Record<string, Figures>
  cardsAfter: Record<string, AgendaCard[]>
  /** What the details dialog shows. */
  open: { title: string; figures: Figures } | null
}

export const useTokens = create<TokensState>(() => ({ rooms: {}, byMessage: {}, cardsAfter: {}, open: null }))

/** Keeps the previous object of an unchanged entry, so only rows whose figures changed re-render. */
function keep<T>(prev: Record<string, T>, next: Record<string, T>): Record<string, T> {
  let same = Object.keys(prev).length === Object.keys(next).length
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(next)) {
    const old = prev[k]
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(v)) out[k] = old
    else { out[k] = v; same = false }
  }
  return same ? prev : out
}

/** Loads the room's calls while developer mode is on (from the oldest loaded
 *  message, again every POLL_MS while the page is visible) and places them. */
export function useRoomTokens(convoId: string, items: Item[]): void {
  const enabled = useDevtools((s) => s.enabled)
  const since = items[0]?.at.toISOString() ?? null
  useEffect(() => {
    if (!enabled || !since) return
    let cancelled = false
    let denied = false
    const load = () => http<Loaded>(
      `/fork/rooms/${encodeURIComponent(convoId)}/tokens?since=${encodeURIComponent(since)}`,
    ).then(
      (r) => {
        if (!cancelled) useTokens.setState((s) => ({ rooms: { ...s.rooms, [convoId]: r } }))
      },
      (e: unknown) => {
        // The answer to a viewer who may not read them does not change on its own.
        denied = e instanceof ApiError && (e.status === 403 || e.status === 404)
        console.warn('[tokens] loading the room\'s token figures failed', e)
      },
    )
    void load()
    const timer = window.setInterval(() => { if (!denied && !document.hidden) void load() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled, convoId, since])

  const loaded = useTokens((s) => s.rooms[convoId])
  const marks = useMemo(() => items.flatMap((it): Mark[] => (it.type === 'msg' ? [{ id: it.msg.id, at: it.at.toISOString(), mine: it.mine }] : [])), [items])
  // A streamed reply or a reaction changes the items without moving a
  // message; place again only when a message comes, goes or changes time.
  const key = marks.map((m) => `${m.id}@${m.at}${m.mine ? '*' : ''}`).join(' ')
  const marksRef = useRef(marks)
  marksRef.current = marks
  useEffect(() => {
    const next = enabled && loaded ? place(marksRef.current, loaded.calls, loaded.agenda, loaded.cut) : { byMessage: {}, cardsAfter: {} }
    useTokens.setState((s) => ({ byMessage: keep(s.byMessage, next.byMessage), cardsAfter: keep(s.cardsAfter, next.cardsAfter) }))
  }, [enabled, key, loaded])
}
