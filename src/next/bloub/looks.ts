/**
 * Which agents wear a bloub avatar, and how: catalogue ids of the vendored
 * engine. A look belongs to the agent for the whole workspace and lives in the
 * fork's SQLite store behind /api/fork/bloub-avatars, so upstream's
 * participants.avatar_url keeps the portrait the classic UI, push and email show.
 *
 * There is no realtime event for it: NextApp loads the looks on start and
 * whenever the app comes back to the foreground.
 */
import { create } from 'zustand'
import { http } from '@/api/client'
import { useAuth } from '@/stores/auth'
import type { ExpressionId } from './engine/expressions'
import type { ColorId, ShapeId } from './engine/skins'

export interface BloubLook { shape: ShapeId; color: ColorId; expression: ExpressionId }

/** bloub's own defaults: the black ball with its resting face. */
export const DEFAULT_LOOK: BloubLook = { shape: 'cercle', color: 'encre', expression: 'neutre' }

interface State {
  byId: Record<string, BloubLook>
  load: () => Promise<void>
  /** Saves a look, or goes back to the portrait with null. Applies locally at
   *  once; a failed write reloads the server's copy and rejects. */
  save: (agentId: string, look: BloubLook | null) => Promise<void>
}

export const useBloubLooks = create<State>((set, get) => {
  // Writes reach the server one at a time in the order they were made.
  let tail: Promise<unknown> = Promise.resolve()
  /** Bumped per write; a load that sees it move drops its now older answer. */
  let writes = 0

  useAuth.subscribe((s, prev) => {
    if (s.contextEpoch !== prev.contextEpoch) set({ byId: {} })
  })

  return {
    byId: {},

    async load() {
      const since = writes
      const epoch = useAuth.getState().contextEpoch
      try {
        const { avatars } = await http<{ avatars: Record<string, BloubLook> }>('/fork/bloub-avatars')
        if (writes !== since || useAuth.getState().contextEpoch !== epoch) return
        // Most foreground returns bring back the same looks; keeping the old
        // object keeps every avatar from re-rendering for nothing.
        if (JSON.stringify(avatars) !== JSON.stringify(get().byId)) set({ byId: avatars })
      } catch (e) {
        console.warn('[next] bloub avatars load failed', e)
      }
    },

    save(agentId, look) {
      writes++
      set((s) => {
        const byId = { ...s.byId }
        if (look) byId[agentId] = look
        else delete byId[agentId]
        return { byId }
      })
      const path = `/fork/bloub-avatars/${encodeURIComponent(agentId)}`
      const run = tail.then(() => http(path, look ? { method: 'PUT', body: JSON.stringify(look) } : { method: 'DELETE' }))
      tail = run.catch(() => {})
      return run.then(() => {}, (e: unknown) => {
        void get().load()
        throw e
      })
    },
  }
})
