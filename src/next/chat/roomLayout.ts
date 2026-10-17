/**
 * The chat list's personal layout: custom categories (their order and whether
 * they are hidden), which category each room sits in, which groups are
 * collapsed, and the order of the pinned tiles. It lives in the fork's own
 * SQLite store (server/src/fork) behind /api/fork, so upstream's Postgres
 * schema never changes for it.
 *
 * Renames, deletes, moves, hides, collapses and tile moves apply locally first
 * and are sent after; a failed one reloads the server's copy so the list never keeps a
 * state the server does not have. Creating a category waits for the server,
 * which assigns the id the room is then filed under.
 */
import { create } from 'zustand'
import { http } from '@/api/client'
import { useAuth } from '@/stores/auth'

export interface Category { id: string; name: string; position: number; hidden: boolean }

interface RoomLayout {
  categories: Category[]
  rooms: Record<string, string>
  collapsed: string[]
  /** Pinned room ids in tile order. Pins themselves live upstream. */
  pinOrder: string[]
}

/** Group key of the built-in section for rooms in no category, collapsible like a category. */
export const OTHER_GROUP = 'other'

interface State extends RoomLayout {
  status: 'idle' | 'ready' | 'error'
  /** The room being dragged with a mouse, so drop zones can show themselves. */
  dragging: string | null
  /** The category whose header is being dragged with a mouse. */
  draggingCategory: string | null
  load: () => Promise<void>
  createCategory: (name: string) => Promise<Category | null>
  renameCategory: (id: string, name: string) => void
  moveCategory: (id: string, position: number) => void
  setHidden: (id: string, hidden: boolean) => void
  deleteCategory: (id: string) => void
  moveRoom: (conversationId: string, categoryId: string | null) => void
  toggleCollapsed: (key: string) => void
  setPinOrder: (ids: string[]) => void
  setDragging: (id: string | null) => void
  setDraggingCategory: (id: string | null) => void
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })
/** Thrown for a request queued in one workspace once another is active. */
const SWITCHED = new Error('workspace changed')

export const useRoomLayout = create<State>((set, get) => {
  // Every request waits for the one before it, so the server applies writes
  // in the order they were made and a load answers after every earlier write.
  let tail: Promise<unknown> = Promise.resolve()
  /** Bumped per write; a load that sees it move drops its now older answer. */
  let writes = 0
  /** A write failed and no load has replaced the local guess yet. */
  let stale = false

  function enqueue<T>(request: () => Promise<T>): Promise<T> {
    const epoch = useAuth.getState().contextEpoch
    // A request queued in one workspace must neither reach nor answer the next.
    const current = () => {
      if (useAuth.getState().contextEpoch !== epoch) throw SWITCHED
    }
    const run = tail.then(async () => {
      current()
      const value = await request()
      current()
      return value
    })
    tail = run.catch(() => {})
    return run
  }

  const send = (path: string, init: RequestInit) => {
    writes++
    enqueue(() => http(path, init)).catch((e) => {
      if (e === SWITCHED) return
      console.warn('[next] room layout write failed', e)
      stale = true
      void get().load()
    })
  }

  // The layout belongs to one person in one workspace. Drop it the moment
  // either changes, so the next workspace never paints the old categories.
  useAuth.subscribe((s, prev) => {
    if (s.contextEpoch !== prev.contextEpoch) set({ categories: [], rooms: {}, collapsed: [], pinOrder: [], status: 'idle', dragging: null, draggingCategory: null })
  })

  /** Native drag and drop holds back mouse events until it ends, so a
   *  buttonless mousemove means the drag is over, even when the source row
   *  remounted mid-drag and its dragend never reached React. */
  const endStaleDrag = (e: MouseEvent) => {
    if (e.buttons !== 0) return
    set({ dragging: null, draggingCategory: null })
    window.removeEventListener('mousemove', endStaleDrag)
  }
  const watchDrag = (active: boolean) => {
    if (active) window.addEventListener('mousemove', endStaleDrag)
    else window.removeEventListener('mousemove', endStaleDrag)
  }

  return {
    categories: [],
    rooms: {},
    collapsed: [],
    pinOrder: [],
    status: 'idle',
    dragging: null,
    draggingCategory: null,

    async load() {
      const since = writes
      try {
        const layout = await enqueue(() => http<RoomLayout>('/fork/room-layout'))
        if (writes !== since) {
          // The local state is newer. A resync, or a first load that has
          // nothing on screen yet, asks again behind the newer write.
          if (stale || get().status !== 'ready') void get().load()
          return
        }
        stale = false
        const s = get()
        // Most foreground returns bring back the same layout; skipping the
        // update keeps every row and tile from re-rendering for nothing.
        if (s.status === 'ready' && JSON.stringify([s.categories, s.rooms, s.collapsed, s.pinOrder]) === JSON.stringify([layout.categories, layout.rooms, layout.collapsed, layout.pinOrder])) return
        set({ ...layout, status: 'ready' })
      } catch (e) {
        if (e === SWITCHED) return
        console.warn('[next] room layout load failed', e)
        set({ status: 'error' })
      }
    },

    async createCategory(name) {
      writes++
      try {
        const { category } = await enqueue(() => http<{ category: Category }>('/fork/categories', { method: 'POST', ...json({ name }) }))
        set((s) => ({ categories: [...s.categories, category] }))
        return category
      } catch (e) {
        if (e !== SWITCHED) console.warn('[next] create category failed', e)
        return null
      }
    },

    renameCategory(id, name) {
      set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, name } : c)) }))
      send(`/fork/categories/${encodeURIComponent(id)}`, { method: 'PATCH', ...json({ name }) })
    },

    moveCategory(id, position) {
      set((s) => ({
        categories: s.categories.map((c) => (c.id === id ? { ...c, position } : c)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
      }))
      send(`/fork/categories/${encodeURIComponent(id)}`, { method: 'PATCH', ...json({ position }) })
    },

    setHidden(id, hidden) {
      set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, hidden } : c)) }))
      send(`/fork/categories/${encodeURIComponent(id)}`, { method: 'PATCH', ...json({ hidden }) })
    },

    deleteCategory(id) {
      set((s) => ({
        categories: s.categories.filter((c) => c.id !== id),
        rooms: Object.fromEntries(Object.entries(s.rooms).filter(([, cat]) => cat !== id)),
        collapsed: s.collapsed.filter((k) => k !== id),
      }))
      send(`/fork/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    moveRoom(conversationId, categoryId) {
      if ((get().rooms[conversationId] ?? null) === categoryId) return
      set((s) => {
        const rooms = { ...s.rooms }
        if (categoryId) rooms[conversationId] = categoryId
        else delete rooms[conversationId]
        return { rooms }
      })
      send(`/fork/rooms/${encodeURIComponent(conversationId)}/category`, { method: 'PUT', ...json({ categoryId }) })
    },

    toggleCollapsed(key) {
      const collapsed = !get().collapsed.includes(key)
      set((s) => ({ collapsed: collapsed ? [...s.collapsed, key] : s.collapsed.filter((k) => k !== key) }))
      send(`/fork/groups/${encodeURIComponent(key)}/collapsed`, { method: 'PUT', ...json({ collapsed }) })
    },

    setPinOrder(ids) {
      set({ pinOrder: ids })
      send('/fork/pin-order', { method: 'PUT', ...json({ conversationIds: ids }) })
    },

    setDragging(id) {
      set({ dragging: id })
      watchDrag(id !== null)
    },

    setDraggingCategory(id) {
      set({ draggingCategory: id })
      watchDrag(id !== null)
    },
  }
})
