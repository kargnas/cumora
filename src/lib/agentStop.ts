/**
 * Stop from the composer: while the box is empty, its send button stops the
 * agents working in the room (fork-only; the server side is
 * server/src/fork/stop.ts). Shared by the Next and classic composers.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { http } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'

/** Send turns into Stop the moment the box empties, so the second click of a
 *  double-click on Send would land on Stop. Clicks this soon after are ignored. */
const ARM_MS = 700

export function useAgentStop(convoId: string | null, idle: boolean): {
  /** The box is empty and an agent's turn shows "typing" in this room. */
  stoppable: boolean
  /** Comma-joined names of those agents, for the button's label. */
  names: string
  busy: boolean
  /** true when the server took every stop request, false when one failed,
   *  null when the click came too soon after the button became Stop. */
  stop: () => Promise<boolean | null>
} {
  const me = useMe()
  const typing = useMessages((s) => (convoId ? s.typing[convoId] : undefined))
  const byId = useParticipants((s) => s.byId)
  const agents = useMemo<Participant[]>(
    () => (typing ?? []).filter((id) => id !== me && byId[id]?.kind === 'agent').map((id) => byId[id]!),
    [typing, me, byId],
  )
  const stoppable = idle && agents.length > 0
  const armedAt = useRef(0)
  // Layout effect: it runs before the browser can deliver a click to the new button.
  useLayoutEffect(() => { if (stoppable) armedAt.current = Date.now() + ARM_MS }, [stoppable])
  const [busy, setBusy] = useState(false)
  const stop = useCallback(async () => {
    if (!convoId || agents.length === 0 || Date.now() < armedAt.current) return null
    setBusy(true)
    try {
      await Promise.all(agents.map((a) =>
        http(`/fork/rooms/${encodeURIComponent(convoId)}/agents/${encodeURIComponent(a.id)}/stop`, { method: 'POST' })))
      return true
    } catch {
      return false
    } finally {
      setBusy(false)
    }
  }, [convoId, agents])
  return { stoppable, names: agents.map((a) => a.name).join(', '), busy, stop }
}
