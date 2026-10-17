import { memo, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
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
import { href, linkClick, navigate } from '../router'
import { listStamp } from '../format'
import { openPalette, useHold, useOpenDirect } from '../hooks'
import { Avatar, AvatarStack } from '../ui/Avatar'
import { IconButton, Menu, MOD, T_FAST, useMenu, type MenuEntry } from '../ui/primitives'
import { IBellOff, ICompose, IHash, IMail, IPin, IPlus, ISearch, IUsers, IExit } from '../ui/icons'

const MAX_TILES = 8

/** Agents in the workspace as tap targets; the ring breathes while one works. */
function AgentTiles() {
  const nt = useNT()
  const agents = useParticipants(useShallow((s) =>
    Object.values(s.byId)
      .filter((p) => p.kind === 'agent' && !p.departedAt)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ))
  const openDirect = useOpenDirect()
  if (agents.length === 0) return null
  const shown = agents.length > MAX_TILES ? agents.slice(0, MAX_TILES - 1) : agents
  const more = agents.length - shown.length
  return (
    <section className="nx-tiles" aria-label={nt('chats.agents')}>
      {shown.map((p) => <AgentTile key={p.id} p={p} onOpen={() => void openDirect(p.id)} />)}
      {more > 0 && (
        <a href={href({ section: 'agents' })} onClick={linkClick} className="nx-tile">
          <span className="nx-tile__more nx-mono">+{more}</span>
          <span className="nx-tile__name">{nt('chats.allAgents')}</span>
        </a>
      )}
    </section>
  )
}

const AgentTile = memo(function AgentTile({ p, onOpen }: { p: Participant; onOpen: () => void }) {
  const nt = useNT()
  const menu = useMenu()
  const hold = useHold((x, y) => menu.openAt({ x, y }))
  return (
    <>
      <button type="button" className="nx-tile" title={p.role ?? p.name} onClick={onOpen} {...hold}>
        <Avatar p={p} size={40} presence />
        <span className="nx-tile__name">{p.name}</span>
      </button>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { key: 'dm', label: nt('chats.message', { name: p.name }), icon: <ICompose />, onSelect: onOpen },
          { key: 'profile', label: nt('chats.profile'), icon: <IUsers />, onSelect: () => navigate(href({ section: 'agents', id: p.id })) },
        ]}
      />
    </>
  )
})

/** Room glyph: the peer for 1:1s, faces for groups, an envelope for mail. */
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

const RoomRow = memo(function RoomRow({ c, active }: { c: Conversation; active: boolean }) {
  const nt = useNT()
  const t = useT()
  const locale = useLocale()
  const typingIds = useMessages((s) => s.typing[c.id])
  const typingName = useParticipants((s) => {
    const id = typingIds?.find((x) => s.byId[x]?.kind === 'agent')
    return id ? s.byId[id]?.name : undefined
  })
  const menu = useMenu()
  const hold = useHold((x, y) => menu.openAt({ x, y }))
  const [creating, setCreating] = useState(false)
  const me = useMe()
  const muted = isMuted(c)
  const unread = c.unread ?? 0

  const run = (fn: () => Promise<unknown>) => () => {
    void fn().then(() => useConversations.getState().reload()).catch((e) => console.warn('[next] room action failed', e))
  }
  const entries: MenuEntry[] = [
    { key: 'pin', label: c.pinned ? t('convo.unpin') : t('convo.pin'), icon: <IPin />, onSelect: run(() => api.togglePin(c.id, !c.pinned)) },
    ...(muted
      ? [{ key: 'unmute', label: t('convo.unmute'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, false, null)) }]
      : [
          { key: 'm1', label: nt('chats.muteHour'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('hour').toISOString())) },
          { key: 'm2', label: nt('chats.muteTomorrow'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('tomorrow').toISOString())) },
          { key: 'm3', label: nt('chats.muteForever'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, null)) },
        ]),
    ...(c.kind === 'direct'
      ? [{ key: 'group', label: nt('chats.newGroupWith'), icon: <IUsers />, onSelect: () => setCreating(true) }]
      : []),
    ...(c.kind === 'group'
      ? ['sep' as const, { key: 'leave', label: t('convo.leaveGroup'), icon: <IExit />, danger: true, onSelect: () => {
          if (window.confirm(nt('chats.leaveConfirm', { name: c.title }))) void run(() => api.leaveConversation(c.id))()
        } }]
      : []),
  ]

  return (
    <>
      <a
        href={href({ section: 'chats', id: c.id })}
        onClick={(e) => linkClick(e, { replace: active })}
        className="nx-room"
        aria-current={active ? 'page' : undefined}
        data-unread={unread > 0 && !muted ? '' : undefined}
        {...hold}
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
      <Menu open={menu.open} anchor={menu.anchor} onClose={menu.close} entries={entries} />
      {creating && <GroupCreator onClose={() => setCreating(false)} initialPicked={c.members.filter((m) => m !== me)} />}
    </>
  )
})

function RoomList({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const me = useMe()
  const list = useConversations((s) => s.list)
  const loaded = useConversations((s) => s.loaded)
  // Deleting an agent off-boards it: the 1:1 room and its history stay, so
  // those rooms move to a Former group at the bottom instead of vanishing.
  const departed = useParticipants(useShallow((s) => Object.values(s.byId).filter((p) => p.departedAt).map((p) => p.id)))
  const groups = useMemo(() => {
    const gone = new Set(departed)
    const former = (c: Conversation) => c.kind === 'direct' && c.members.some((m) => m !== me && gone.has(m))
    const rooms = list.filter((c) => c.kind !== 'whisper' && !former(c))
    return [
      { key: 'pinned', label: nt('chats.pinned'), items: rooms.filter((c) => c.pinned) },
      { key: 'rooms', label: nt('chats.rooms'), items: rooms.filter((c) => !c.pinned && c.kind === 'group') },
      { key: 'direct', label: nt('chats.direct'), items: rooms.filter((c) => !c.pinned && c.kind === 'direct') },
      { key: 'email', label: nt('chats.email'), items: rooms.filter((c) => !c.pinned && c.kind === 'email') },
      { key: 'former', label: nt('chats.former'), items: list.filter(former) },
    ].filter((g) => g.items.length > 0)
  }, [list, departed, me, nt])

  if (!loaded) {
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
  if (groups.length === 0) {
    return <div className="nx-empty"><b>{nt('chats.emptyTitle')}</b>{nt('chats.emptyBody')}</div>
  }
  return (
    <div className="nx-rooms">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="nx-group-label">{g.label}</h2>
          {g.items.map((c) => <RoomRow key={c.id} c={c} active={c.id === activeId} />)}
        </section>
      ))}
    </div>
  )
}

export function Sidebar({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const menu = useMenu()
  const [creating, setCreating] = useState(false)
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
        <AgentTiles />
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
        ]}
      />
      {creating && <GroupCreator onClose={() => setCreating(false)} />}
    </aside>
  )
}

