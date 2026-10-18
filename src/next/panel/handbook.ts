/**
 * Data for the Handbook, from the fork route GET /api/fork/agents/:id/handbook
 * (server/src/fork/handbook.ts). The types mirror that file's response.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, http } from '@/api/client'

export type Seg = ['=' | '-' | '+', string]
export type ChangedLine = { op: 'del' | 'ins'; text: string } | { op: 'edit'; segs: Seg[] }
export type Part = { same: string[] } | { change: number; lines: ChangedLine[] }
export type SectionKey = 'instructions' | 'memory' | 'skills'

export interface HandbookFile {
  key: string
  path: string
  shared: boolean
  state: 'same' | 'changed' | 'created' | 'deleted'
  parts: Part[]
}

export interface Instruction {
  authorId: string
  at: string
  visible: boolean
  conversationId: string | null
  messageId: string | null
  text: string | null
}

export interface HandbookChange {
  n: number
  at: string
  path: string
  kind: 'created' | 'edited' | 'deleted'
  agentId: string | null
  instruction: Instruction | null
}

export type ReadyHandbook = { available: true; sections: Array<{ key: SectionKey; files: HandbookFile[] }>; changes: HandbookChange[] }
export type Handbook = { available: false } | ReadyHandbook

export type Since = 'today' | '7d' | '30d' | 'all'
export const SINCES: Since[] = ['today', '7d', '30d', 'all']

export function parseSince(raw: string | null): Since {
  return SINCES.includes(raw as Since) ? raw as Since : 'today'
}

/** Where the range starts, in the viewer's own time zone: midnight today, or
 *  the midnight 6 or 29 days before, so "7 days" is today and the six before.
 *  The value holds all day, so every poll asks for the same URL. */
export function sinceTime(since: Since, now = new Date()): string | null {
  if (since === 'all') return null
  const back = since === 'today' ? 0 : since === '7d' ? 6 : 29
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).toISOString()
}

const POLL_MS = 15_000

/** Keeps the previous object of every file that did not change, so its rows
 *  skip re-rendering, and the whole previous answer when nothing did. */
function keepUnchanged(prev: Handbook | null, next: Handbook): Handbook {
  if (!prev?.available || !next.available) return next
  if (JSON.stringify(prev) === JSON.stringify(next)) return prev
  const old = new Map(prev.sections.flatMap((s) => s.files).map((f) => [f.key, f]))
  return {
    ...next,
    sections: next.sections.map((s) => ({
      ...s,
      files: s.files.map((f) => {
        const o = old.get(f.key)
        return o && JSON.stringify(o) === JSON.stringify(f) ? o : f
      }),
    })),
  }
}

export type HandbookError = 'locked' | 'failed'

/**
 * Loads one agent's handbook for a range and polls it every POLL_MS while it
 * is open and the page is visible. While a new range loads, the last answer
 * for the same agent stays (with `current` false); another agent's never shows.
 */
export function useHandbook(agentId: string, since: string | null, at: string | null): {
  data: Handbook | null
  current: boolean
  error: HandbookError | null
  retry: () => void
} {
  const query = new URLSearchParams()
  if (since) query.set('since', since)
  if (at) query.set('at', at)
  const qs = query.toString()
  const path = `/fork/agents/${encodeURIComponent(agentId)}/handbook${qs ? `?${qs}` : ''}`
  const [state, setState] = useState<{ agentId: string; path: string | null; data: Handbook | null; error: HandbookError | null }>(
    { agentId, path: null, data: null, error: null },
  )
  const [attempt, setAttempt] = useState(0)
  const locked = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = () => http<Handbook>(path).then(
      (next) => {
        if (cancelled) return
        locked.current = false
        setState((s) => ({ agentId, path, data: keepUnchanged(s.agentId === agentId ? s.data : null, next), error: null }))
      },
      (e: unknown) => {
        if (cancelled) return
        const error: HandbookError = e instanceof ApiError && e.status === 403 ? 'locked' : 'failed'
        locked.current = error === 'locked'
        setState((s) => (s.agentId === agentId ? { ...s, error } : { agentId, path: null, data: null, error }))
      },
    )
    void load()
    // Polling waits while the page is hidden, and stops for a viewer who is
    // not allowed in: that answer does not change on its own.
    const timer = window.setInterval(() => { if (!document.hidden && !locked.current) void load() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // attempt only re-runs the effect: a retry loads again.
  }, [agentId, path, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const mine = state.agentId === agentId
  return {
    data: mine ? state.data : null,
    current: mine && state.path === path,
    error: mine ? state.error : null,
    retry,
  }
}
