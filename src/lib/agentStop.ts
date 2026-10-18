/**
 * Stop from the composer: while the box is empty, its send button stops the
 * agents working in the room (fork-only; the server side is
 * server/src/fork/stop.ts). Shared by the Next and classic composers.
 */
import { useCallback, useMemo, useState } from 'react'
import { http } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'

export function useAgentStop(convoId: string | null): {
  /** Agents whose turn shows "typing" in this room right now. */
  agents: Participant[]
  /** Comma-joined names, for the button's label. */
  names: string
  busy: boolean
  /** Resolves true when the server took every stop request. */
  stop: () => Promise<boolean>
} {
  const me = useMe()
  const typing = useMessages((s) => (convoId ? s.typing[convoId] : undefined))
  const byId = useParticipants((s) => s.byId)
  const agents = useMemo(
    () => (typing ?? []).filter((id) => id !== me && byId[id]?.kind === 'agent').map((id) => byId[id]!),
    [typing, me, byId],
  )
  const [busy, setBusy] = useState(false)
  const stop = useCallback(async () => {
    if (!convoId || agents.length === 0) return false
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
  return { agents, names: agents.map((a) => a.name).join(', '), busy, stop }
}
