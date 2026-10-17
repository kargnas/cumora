/**
 * Data for the Activity tab, from the fork route GET /api/fork/rooms/:id/activity
 * (server/src/fork/activity.ts). The types mirror that file's response.
 */
import { useCallback, useEffect, useState } from 'react'
import { http } from '@/api/client'

export type RunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stalled'

export type EffectKind =
  | 'card.created' | 'card.moved' | 'card.updated' | 'card.deleted' | 'comment.created'
  | 'board.created' | 'doc.created' | 'doc.edited' | 'doc.deleted' | 'event.created'
  | 'message.posted'

export type EffectRef =
  | { type: 'board'; id: string; cardId: string | null }
  | { type: 'doc'; id: string }
  | { type: 'event'; id: string }
  | { type: 'room'; id: string; messageId: string }

export interface ActivityEffect {
  kind: EffectKind
  title: string | null
  where: string | null
  count: number
  ref: EffectRef | null
}

export interface ActivityProblem {
  kind: 'failed' | 'stalled' | 'error' | 'step'
  title: string | null
  text: string | null
}

export interface ActivityStep {
  name: string
  text: string | null
  status: string | null
  ok: boolean | null
  durationMs: number | null
}

export interface ActivityRun {
  id: string
  agentId: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  updatedAt: string
  durationMs: number
  costUsd: number
  costEstimated: boolean
  model: string | null
  summary: string | null
  effects: ActivityEffect[]
  problems: ActivityProblem[]
  steps: ActivityStep[]
  stepCount: number
}

export interface RoutineFailure {
  id: string
  agentId: string | null
  at: string
  title: string | null
  text: string | null
}

export interface RoomActivity {
  runs: ActivityRun[]
  routines: RoutineFailure[]
}

const POLL_MS = 8000

/** Keeps the previous object of every run and routine that did not change, so
 *  the memoized cards skip re-rendering on each poll. */
function keepUnchanged(prev: RoomActivity | null, next: RoomActivity): RoomActivity {
  if (!prev) return next
  const reuse = <T extends { id: string }>(old: T[], fresh: T[]): T[] => {
    const byId = new Map(old.map((x) => [x.id, x]))
    return fresh.map((x) => {
      const o = byId.get(x.id)
      return o && JSON.stringify(o) === JSON.stringify(x) ? o : x
    })
  }
  const runs = reuse(prev.runs, next.runs)
  const routines = reuse(prev.routines, next.routines)
  const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])
  return same(runs, prev.runs) && same(routines, prev.routines) ? prev : { runs, routines }
}

/** Loads on open and on every room change, then every POLL_MS while an agent
 *  here is live or a run is still open (a run can outlast its agent's live
 *  status by a moment, and a stalled one until the server closes it). */
export function useRoomActivity(convoId: string, live: boolean): {
  data: RoomActivity | null
  failed: boolean
  retry: () => void
} {
  const [state, setState] = useState<{ convoId: string; data: RoomActivity | null; failed: boolean }>(
    { convoId, data: null, failed: false },
  )
  const [attempt, setAttempt] = useState(0)
  // Another room's runs never show while this room's load is in flight.
  const current = state.convoId === convoId ? state : null
  const open = current?.data?.runs.some((r) => r.status === 'running' || r.status === 'stalled') ?? false
  const poll = live || open

  useEffect(() => {
    let cancelled = false
    const load = () => http<RoomActivity>(`/fork/rooms/${encodeURIComponent(convoId)}/activity`).then(
      (next) => {
        if (!cancelled) setState((s) => ({ convoId, data: keepUnchanged(s.convoId === convoId ? s.data : null, next), failed: false }))
      },
      () => {
        if (!cancelled) setState((s) => (s.convoId === convoId ? { ...s, failed: true } : { convoId, data: null, failed: true }))
      },
    )
    void load()
    const timer = poll ? window.setInterval(load, POLL_MS) : undefined
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
    }
    // attempt only re-runs the effect: a retry loads again.
  }, [convoId, poll, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { data: current?.data ?? null, failed: current?.failed ?? false, retry }
}

/** "$0.08", or "<$0.01" for the cent fractions a short run costs. */
export function usd(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}
