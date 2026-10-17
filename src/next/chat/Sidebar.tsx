import { memo, useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { motion } from 'framer-motion'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '@/api/client'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { isMuted, useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale, useT } from '@/lib/i18n'
import { PreviewText } from '@/components/PreviewText'
import { GroupCreator } from '@/components/GroupCreator'
import type { Conversation, Participant } from '@/types'
import { useNT } from '../i18n'
import { href, linkClick } from '../router'
import { listStamp } from '../format'
import { openPalette, useHold } from '../hooks'
import { Avatar, AvatarStack } from '../ui/Avatar'
import { Dialog, IconButton, Menu, MOD, Spinner, T_FAST, useCoarse, useMenu, type MenuAnchor, type MenuEntry } from '../ui/primitives'
import { IBellOff, IChevronDown, ICompose, IFolder, IHash, IMail, IPencil, IPin, IPlus, ISearch, ITrash, IUsers, IExit } from '../ui/icons'
import { FORMER_GROUP, OTHER_GROUP, useRoomLayout, type Category } from './roomLayout'

/** Our own drag payload, so files or text dragged over the list are ignored. */
const ROOM_MIME = 'application/x-nx-room'
const carriesRoom = (e: DragEvent) => e.dataTransfer.types.includes(ROOM_MIME)
// React 18 drops an unknown boolean prop; an empty string reaches the DOM, and
// inert keeps focus and clicks out of a collapsed group.
const INERT = { inert: '' } as Record<string, string>

/** The room's face wherever a room is listed: the peer for a 1:1, the
 *  agents for a group, a glyph otherwise. */
export function RoomGlyph({ c, size = 36 }: { c: Conversation; size?: number }) {
  const me = useMe()
  const peerId = c.kind === 'direct' ? c.members.find((m) => m !== me) ?? c.members[0] : null
  const peer = useParticipants((s) => (peerId ? s.byId[peerId] : undefined))
  const faces = useParticipants(useShallow((s) => (c.kind === 'group'
    ? c.members.map((id) => s.byId[id]).filter((p): p is Participant => Boolean(p) && p.kind === 'agent').slice(0, 2)
    : [])))
  if (c.kind === 'direct' && peer) return <Avatar p={peer} size={size} presence />
  if (c.kind === 'email') return <span className="nx-room-glyph"><IMail /></span>
  if (faces.length >= 2) return <span className="nx-room-glyph nx-room-glyph--faces"><AvatarStack ps={faces} size={Math.round((size * 2) / 3)} max={2} /></span>
  return <span className="nx-room-glyph"><IHash /></span>
}

/** Next-morning / next-Monday mute presets, same as the classic sidebar. */
function muteUntil(kind: 'hour' | 'tomorrow' | 'week'): Date {
  const d = new Date()
  if (kind === 'hour') return new Date(d.getTime() + 3600_000)
  if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d
  }
  d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7))
  d.setHours(9, 0, 0, 0)
  return d
}

/** Start loading a room's messages when a pointer heads for it, so the
 *  click lands on a warm cache and the transcript paints without a skeleton.
 *  Loading is not reading: App.tsx marks a room read only once it is shown. */
function prefetch(id: string): void {
  const s = useMessages.getState()
  if (!s.loaded.has(id) && !s.loading.has(id)) void s.loadConversation(id)
}

/** Pin state is a conversation column on the server; flip it locally first so
 *  a drop lands instantly, then let the reload confirm it. */
function setPinned(id: string, pinned: boolean): void {
  useConversations.setState((s) => ({ list: s.list.map((c) => (c.id === id ? { ...c, pinned } : c)) }))
  void api.togglePin(id, pinned)
    .catch((e) => console.warn('[next] pin failed', e))
    .finally(() => void useConversations.getState().reload())
}

/** File a room under a category (null for Other), out of the pinned row. */
function fileRoom(id: string, categoryId: string | null): void {
  if (useConversations.getState().list.find((c) => c.id === id)?.pinned) setPinned(id, false)
  useRoomLayout.getState().moveRoom(id, categoryId)
}

/** The list's one menu and the dialogs it opens. They render once in the
 *  sidebar rather than in the row, so an action that moves or removes the row
 *  that opened them (Move to, Pin, Delete category) leaves them to animate
 *  out instead of unmounting them with it. */
interface ListMenuState {
  /** What the menu and dialogs act on. It outlives the menu, so a dialog the
   *  menu opened still knows its room or category. */
  target: { room: string; former: boolean } | { category: string } | null
  anchor: MenuAnchor | null
  dialog: 'group' | 'category' | 'rename' | null
}
const useListMenu = create<ListMenuState>(() => ({ target: null, anchor: null, dialog: null }))
const openListMenu = (target: NonNullable<ListMenuState['target']>, x: number, y: number) => useListMenu.setState({ target, anchor: { x, y } })

/** The frame that marks a drag as started; dragend cancels it if it comes first. */
let dragFrame = 0

/** Drag source props for rooms and tiles. Touch has no mouse drag; it moves
 *  rooms from the hold menu instead, which keeps long-press free for that. */
function useDragSource(id: string, enabled: boolean) {
  const coarse = useCoarse()
  const dragging = useRoomLayout((s) => s.dragging === id)
  if (coarse || !enabled) return {}
  return {
    draggable: true,
    'data-dragging': dragging || undefined,
    onDragStart: (e: DragEvent) => {
      // Drop the link's own URL payload, or the composer would accept the
      // drop as text; and drag the row itself, not Chrome's URL chip.
      e.dataTransfer.clearData()
      e.dataTransfer.setData(ROOM_MIME, id)
      const r = e.currentTarget.getBoundingClientRect()
      e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
      e.dataTransfer.effectAllowed = 'move'
      // The browser takes the drag image right after this handler returns. A
      // commit before that would fade the ghost and grow drop zones under the
      // pointer, so the drag state lands on the next frame.
      dragFrame = requestAnimationFrame(() => useRoomLayout.getState().setDragging(id))
    },
    onDragEnd: () => {
      cancelAnimationFrame(dragFrame)
      useRoomLayout.getState().setDragging(null)
    },
  }
}

/** Drop target props; `over` lights the target while a room hovers it. */
function useDropTarget(onDrop: (e: DragEvent) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesRoom(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        setOver(false)
        // A dropped row often moves to another list and unmounts, so its own
        // dragend never fires; the drop ends the drag instead.
        useRoomLayout.getState().setDragging(null)
        onDrop(e)
      },
    },
  }
}

/** `onSubmit` returns a promise when the server has to answer first: the
 *  dialog stays open and busy until then, and keeps the name on failure. */
function CategoryDialog({ open, initial = '', title, action, onClose, onSubmit }: {
  open: boolean
  initial?: string
  title: string
  action: string
  onClose: () => void
  onSubmit: (name: string) => Promise<boolean> | undefined
}) {
  const nt = useNT()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(initial)
    setFailed(false)
  }, [open, initial])
  const value = name.trim()
  // Closing mid-request would leave its outcome nowhere to show.
  const close = () => { if (!busy) onClose() }
  return (
    <Dialog open={open} onClose={close} title={title}>
      <form
        className="nx-category-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value || busy) return
          const pending = onSubmit(value)
          if (!pending) {
            onClose()
            return
          }
          setBusy(true)
          setFailed(false)
          void pending.then((ok) => {
            setBusy(false)
            if (ok) onClose()
            else setFailed(true)
          })
        }}
      >
        <input
          className="nx-input"
          autoFocus
          value={name}
          maxLength={60}
          placeholder={nt('chats.categoryName')}
          aria-label={nt('chats.categoryName')}
          onChange={(e) => setName(e.target.value)}
        />
        {failed && <p className="nx-category-form__error" role="alert">{nt('chats.createCategoryFailed')}</p>}
        <div className="nx-category-form__actions">
          <button type="button" className="nx-btn" disabled={busy} onClick={close}>{nt('common.cancel')}</button>
          <button type="submit" className="nx-btn nx-btn--primary" disabled={!value || busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}{action}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** The shared host for room and category menus (see `useListMenu`). */
function ListMenu() {
  const nt = useNT()
  const t = useT()
  const me = useMe()
  const { target, anchor, dialog } = useListMenu()
  const roomId = target && 'room' in target ? target.room : null
  const former = target !== null && 'room' in target && target.former
  const categoryId = target && 'category' in target ? target.category : null
  const room = useConversations((s) => (roomId ? s.list.find((c) => c.id === roomId) : undefined))
  const category = useRoomLayout((s) => (categoryId ? s.categories.find((k) => k.id === categoryId) : undefined))
  const categories = useRoomLayout((s) => s.categories)
  const current = useRoomLayout((s) => (roomId ? s.rooms[roomId] ?? null : null))
  const close = useCallback(() => useListMenu.setState({ anchor: null }), [])
  const closeDialog = useCallback(() => useListMenu.setState({ dialog: null }), [])
  const run = (fn: () => Promise<unknown>) => () => {
    void fn().then(() => useConversations.getState().reload()).catch((e) => console.warn('[next] room action failed', e))
  }

  let entries: MenuEntry[] = []
  if (room) {
    const c = room
    entries = [
      { key: 'pin', label: c.pinned ? t('convo.unpin') : t('convo.pin'), icon: <IPin />, onSelect: () => setPinned(c.id, !c.pinned) },
      ...(isMuted(c)
        ? [{ key: 'unmute', label: t('convo.unmute'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, false, null)) }]
        : [
            { key: 'm1', label: nt('chats.muteHour'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('hour').toISOString())) },
            { key: 'm2', label: nt('chats.muteTomorrow'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('tomorrow').toISOString())) },
            { key: 'm3', label: nt('chats.muteForever'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, null)) },
          ]),
      ...(c.pinned || former
        ? []
        : [
            'sep' as const,
            { label: nt('chats.moveTo') },
            ...categories.filter((k) => k.id !== current).map((k) => ({ key: `cat-${k.id}`, label: k.name, icon: <IFolder />, onSelect: () => fileRoom(c.id, k.id) })),
            ...(current ? [{ key: 'cat-other', label: nt('chats.other'), icon: <IFolder />, onSelect: () => fileRoom(c.id, null) }] : []),
            { key: 'cat-new', label: nt('chats.newCategory'), icon: <IPlus />, onSelect: () => useListMenu.setState({ dialog: 'category' }) },
          ]),
      ...(c.kind === 'direct'
        ? ['sep' as const, { key: 'group', label: nt('chats.newGroupWith'), icon: <IUsers />, onSelect: () => useListMenu.setState({ dialog: 'group' }) }]
        : []),
      ...(c.kind === 'group'
        ? ['sep' as const, { key: 'leave', label: t('convo.leaveGroup'), icon: <IExit />, danger: true, onSelect: () => {
            if (window.confirm(nt('chats.leaveConfirm', { name: c.title }))) void run(() => api.leaveConversation(c.id))()
          } }]
        : []),
    ]
  } else if (category) {
    const k = category
    entries = [
      { key: 'rename', label: nt('chats.renameCategory'), icon: <IPencil />, onSelect: () => useListMenu.setState({ dialog: 'rename' }) },
      { key: 'delete', label: nt('chats.deleteCategory'), icon: <ITrash />, danger: true, onSelect: () => {
        if (window.confirm(nt('chats.deleteCategoryConfirm', { name: k.name }))) useRoomLayout.getState().deleteCategory(k.id)
      } },
    ]
  }

  const renaming = dialog === 'rename'
  return (
    <>
      <Menu open={anchor !== null} anchor={anchor} onClose={close} entries={entries} />
      {dialog === 'group' && room && <GroupCreator onClose={closeDialog} initialPicked={room.members.filter((m) => m !== me)} />}
      <CategoryDialog
        open={dialog === 'category' || renaming}
        initial={renaming ? category?.name : ''}
        title={nt(renaming ? 'chats.renameCategory' : 'chats.newCategory')}
        action={nt(renaming ? 'chats.save' : 'chats.create')}
        onClose={closeDialog}
        onSubmit={(name) => {
          if (renaming) {
            if (category) useRoomLayout.getState().renameCategory(category.id, name)
            return undefined
          }
          // A new category files the room it was asked for from, if any.
          return useRoomLayout.getState().createCategory(name).then((cat) => {
            if (cat && roomId) fileRoom(roomId, cat.id)
            return cat !== null
          })
        }}
      />
    </>
  )
}

const RoomTile = memo(function RoomTile({ c, active }: { c: Conversation; active: boolean }) {
  const hold = useHold((x, y) => openListMenu({ room: c.id, former: false }, x, y))
  const drag = useDragSource(c.id, true)
  const unread = c.unread ?? 0
  const muted = isMuted(c)
  return (
    <a
      href={href({ section: 'chats', id: c.id })}
      onClick={(e) => linkClick(e, { replace: active })}
      className="nx-tile"
      title={c.title}
      aria-current={active ? 'page' : undefined}
      {...hold}
      {...drag}
      onPointerEnter={() => prefetch(c.id)}
      onTouchStart={(e) => { prefetch(c.id); hold.onTouchStart(e) }}
    >
      <span className="nx-tile__face">
        <RoomGlyph c={c} size={40} />
        {unread > 0 && <span className={muted ? 'nx-badge nx-badge--muted nx-tile__badge' : 'nx-badge nx-tile__badge'}>{unread > 99 ? '99+' : unread}</span>}
      </span>
      <span className="nx-tile__name">{c.title}</span>
    </a>
  )
})

/** Pinned rooms sit on top as tiles and wrap onto new rows as they grow.
 *  While a room is dragged the row is a drop target that pins it; with
 *  nothing pinned, a zone floats over the top of the list instead, so no row
 *  moves under the pointer. */
function PinnedTiles({ rooms, activeId }: { rooms: Conversation[]; activeId: string | null }) {
  const nt = useNT()
  const dragging = useRoomLayout((s) => s.dragging !== null)
  const drop = useDropTarget((e) => {
    const id = e.dataTransfer.getData(ROOM_MIME)
    if (id && !useConversations.getState().list.find((c) => c.id === id)?.pinned) setPinned(id, true)
  })
  if (rooms.length === 0) {
    if (!dragging) return null
    return (
      <div className="nx-pin-drop">
        <div className="nx-pin-drop__zone" data-drop={drop.over || undefined} {...drop.props}>{nt('chats.dropToPin')}</div>
      </div>
    )
  }
  return (
    <section className="nx-tiles" aria-label={nt('chats.pinned')} data-drop={drop.over || undefined} {...drop.props}>
      {rooms.map((c) => <RoomTile key={c.id} c={c} active={c.id === activeId} />)}
    </section>
  )
}

const RoomRow = memo(function RoomRow({ c, active, former }: { c: Conversation; active: boolean; former: boolean }) {
  const nt = useNT()
  const t = useT()
  const locale = useLocale()
  const typingIds = useMessages((s) => s.typing[c.id])
  const typingName = useParticipants((s) => {
    const id = typingIds?.find((x) => s.byId[x]?.kind === 'agent')
    return id ? s.byId[id]?.name : undefined
  })
  const hold = useHold((x, y) => openListMenu({ room: c.id, former }, x, y))
  const drag = useDragSource(c.id, !former)
  const muted = isMuted(c)
  const unread = c.unread ?? 0

  return (
    <a
      href={href({ section: 'chats', id: c.id })}
      onClick={(e) => linkClick(e, { replace: active })}
      className="nx-room"
      aria-current={active ? 'page' : undefined}
      data-unread={unread > 0 && !muted ? '' : undefined}
      {...hold}
      {...drag}
      onPointerEnter={() => prefetch(c.id)}
      onTouchStart={(e) => { prefetch(c.id); hold.onTouchStart(e) }}
    >
      {active && <motion.span layoutId="nx-room-sel" className="nx-room__sel" transition={T_FAST} />}
      <RoomGlyph c={c} />
      <span className="nx-room__main">
        <span className="nx-room__top">
          <span className="nx-room__title">{c.title}</span>
          {muted && <IBellOff className="nx-room__muted" aria-label={t('convo.muted')} />}
          <span className="nx-room__time nx-mono">{listStamp(c.lastAtIso, locale)}</span>
        </span>
        <span className="nx-room__bottom">
          {typingName ? (
            <span className="nx-room__preview nx-shimmer">{nt('chats.isWorking', { name: typingName })}</span>
          ) : (
            <span className="nx-room__preview">{c.preview ? <PreviewText body={c.preview} emojiSize={13} /> : nt('chats.noMessages')}</span>
          )}
          {unread > 0 && <span className={muted ? 'nx-badge nx-badge--muted' : 'nx-badge'}>{unread > 99 ? '99+' : unread}</span>}
        </span>
      </span>
    </a>
  )
})

interface Group {
  key: string
  /** Null for the only group when no category exists: the list needs no header. */
  label: string | null
  rooms: Conversation[]
  category?: Category
  former?: boolean
}

function GroupSection({ g, activeId }: { g: Group; activeId: string | null }) {
  const nt = useNT()
  const coarse = useCoarse()
  const collapsed = useRoomLayout((s) => g.label !== null && s.collapsed.includes(g.key))
  const hold = useHold((x, y) => { if (g.category) openListMenu({ category: g.category.id }, x, y) })
  const drop = useDropTarget((e) => {
    const id = e.dataTransfer.getData(ROOM_MIME)
    if (id) fileRoom(id, g.category?.id ?? null)
  })
  const unread = g.rooms.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread ?? 0), 0)
  const target = g.former ? {} : drop.props
  return (
    <section className="nx-group" aria-label={g.label ?? undefined} data-collapsed={collapsed || undefined} data-drop={drop.over || undefined} {...target}>
      {g.label !== null && (
        <h2 className="nx-group__head">
          <button
            type="button"
            className="nx-group__toggle"
            aria-expanded={!collapsed}
            onClick={() => useRoomLayout.getState().toggleCollapsed(g.key)}
            {...(g.category ? hold : {})}
          >
            <IChevronDown className="nx-group__chev" />
            <span className="nx-group__label">{g.label}</span>
            {collapsed && unread > 0 && <span className="nx-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        </h2>
      )}
      {/* Collapsing animates grid rows 1fr → 0fr: the browser interpolates the
          height without a JS measurement (a layout pass per frame, see shell.css). */}
      <div className="nx-group__body" {...(collapsed ? INERT : {})}>
        <div className="nx-group__inner">
          {g.rooms.map((c) => <RoomRow key={c.id} c={c} active={c.id === activeId} former={!!g.former} />)}
          {/* Touch has no mouse drag; rooms move from their long-press menu. */}
          {g.rooms.length === 0 && <div className="nx-group__empty">{nt(coarse ? 'chats.holdToMove' : 'chats.dragHere')}</div>}
        </div>
      </div>
    </section>
  )
}

/** Dropping a room here asks for a name and files the room under it. */
function NewCategoryDrop() {
  const nt = useNT()
  const drop = useDropTarget((e) => {
    const id = e.dataTransfer.getData(ROOM_MIME)
    if (id) useListMenu.setState({ target: { room: id, former: false }, dialog: 'category' })
  })
  const dragging = useRoomLayout((s) => s.dragging !== null)
  if (!dragging) return null
  return (
    <div className="nx-group-new" data-drop={drop.over || undefined} {...drop.props}>
      <IPlus />{nt('chats.dropNewCategory')}
    </div>
  )
}

/** Retries the layout load, showing the wait on the button itself. */
function LayoutRetry() {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="nx-group-error"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true)
        void useRoomLayout.getState().load().finally(() => setBusy(false))
      }}
    >
      {busy && <Spinner />}{nt('chats.layoutError')}
    </button>
  )
}

function RoomList({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const me = useMe()
  const list = useConversations((s) => s.list)
  const loaded = useConversations((s) => s.loaded)
  const layout = useRoomLayout(useShallow((s) => ({ status: s.status, categories: s.categories, rooms: s.rooms })))
  const dragging = useRoomLayout((s) => s.dragging !== null)
  // Deleting an agent off-boards it: the 1:1 room and its history stay, so
  // those rooms move to a Former group at the bottom instead of vanishing.
  const departed = useParticipants(useShallow((s) => Object.values(s.byId).filter((p) => p.departedAt).map((p) => p.id)))

  const { pinned, groups } = useMemo(() => {
    const gone = new Set(departed)
    const isFormer = (c: Conversation) => c.kind === 'direct' && c.members.some((m) => m !== me && gone.has(m))
    const rooms = list.filter((c) => c.kind !== 'whisper')
    const live = rooms.filter((c) => !isFormer(c))
    const byCategory = new Map(layout.categories.map((k) => [k.id, [] as Conversation[]]))
    const other: Conversation[] = []
    for (const c of live) {
      if (c.pinned) continue
      const bucket = byCategory.get(layout.rooms[c.id] ?? '')
      if (bucket) bucket.push(c)
      else other.push(c)
    }
    const former = rooms.filter(isFormer)
    const out: Group[] = layout.categories.map((k) => ({ key: k.id, label: k.name, rooms: byCategory.get(k.id) ?? [], category: k }))
    out.push({ key: OTHER_GROUP, label: layout.categories.length > 0 ? nt('chats.other') : null, rooms: other })
    if (former.length > 0) out.push({ key: FORMER_GROUP, label: nt('chats.former'), rooms: former, former: true })
    return { pinned: live.filter((c) => c.pinned), groups: out }
  }, [list, layout, departed, me, nt])

  // Hold the skeleton until the layout arrives too, so rooms never jump into
  // their categories after first paint.
  if (!loaded || layout.status === 'idle') {
    return (
      <div className="nx-rooms" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="nx-room nx-room--skel">
            <span className="nx-skel" style={{ width: 36, height: 36, borderRadius: 999 }} />
            <span className="nx-room__main">
              <span className="nx-skel" style={{ width: '60%', height: 12 }} />
              <span className="nx-skel" style={{ width: '85%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (pinned.length === 0 && groups.every((g) => g.rooms.length === 0) && layout.categories.length === 0) {
    return <div className="nx-empty"><b>{nt('chats.emptyTitle')}</b>{nt('chats.emptyBody')}</div>
  }
  return (
    <>
      <PinnedTiles rooms={pinned} activeId={activeId} />
      {layout.status === 'error' && <LayoutRetry />}
      <div className="nx-rooms">
        {groups
          // An empty Other only shows up as a drop target while dragging.
          .filter((g) => g.rooms.length > 0 || g.category || (dragging && g.key === OTHER_GROUP))
          .map((g) => <GroupSection key={g.key} g={g} activeId={activeId} />)}
        <NewCategoryDrop />
      </div>
    </>
  )
}

export function Sidebar({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const menu = useMenu()
  const [creating, setCreating] = useState(false)
  // The layout is per person and edited from every device, so it is fetched
  // again whenever the app comes back to the foreground.
  useEffect(() => {
    const load = () => void useRoomLayout.getState().load()
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  return (
    <aside className="nx-sidebar" aria-label={nt('chats.title')}>
      <header className="nx-sidebar__head">
        <h1>{nt('chats.title')}</h1>
        <IconButton label={nt('chats.search')} shortcut={`${MOD}K`} tipPlace="below" ring onClick={() => openPalette()}>
          <ISearch />
        </IconButton>
        <IconButton label={nt('chats.new')} tipPlace="below" ring onClick={(e) => menu.toggleFrom(e.currentTarget, 'end')}>
          <IPlus />
        </IconButton>
      </header>
      <div className="nx-sidebar__scroll nx-scroll">
        <RoomList activeId={activeId} />
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { key: 'dm', label: nt('chats.newDirect'), icon: <ICompose />, onSelect: () => openPalette('people') },
          { key: 'group', label: nt('chats.newGroup'), icon: <IUsers />, onSelect: () => setCreating(true) },
          { key: 'mail', label: nt('chats.newEmail'), icon: <IMail />, onSelect: () => useApp.getState().openComposeNew() },
          'sep',
          { key: 'category', label: nt('chats.newCategory'), icon: <IFolder />, onSelect: () => useListMenu.setState({ target: null, dialog: 'category' }) },
        ]}
      />
      {creating && <GroupCreator onClose={() => setCreating(false)} />}
      <ListMenu />
    </aside>
  )
}
