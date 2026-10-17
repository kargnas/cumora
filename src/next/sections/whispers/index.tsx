import { memo, useEffect, useMemo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import type { ApiWhisper, ApiWhisperMessage } from '@/api/client'
import { useWhispers, whisperMessages, type WhispersStateLike } from '@/stores/whispers'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'
import { RichBody, SystemRow } from '@/components/Message'
import { useLocale } from '@/lib/i18n'
import { useNT } from '../../i18n'
import { clock, listStamp } from '../../format'
import { goBack, href, linkClick, navigate } from '../../router'
import type { SectionProps } from '../types'
import { Avatar, AvatarStack } from '../../ui/Avatar'
import { IconButton, Spinner } from '../../ui/primitives'
import { IChevronLeft, IInfo, IWhisper } from '../../ui/icons'
import './whispers.css'

function validDate(raw: string): Date {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function membersOf(w: ApiWhisper, byId: Record<string, Participant>): Participant[] {
  return w.members.map((id) => byId[id]).filter((p): p is Participant => Boolean(p))
}

function whisperTitle(w: ApiWhisper, members: Participant[], nt: ReturnType<typeof useNT>): string {
  if (w.title) return w.title
  if (members.length === 2) return `${members[0].name} ↔ ${members[1].name}`
  return nt('whispers.untitled', { n: members.length })
}

const WhisperRow = memo(function WhisperRow({ w, selected, onOpen }: { w: ApiWhisper; selected: boolean; onOpen: (id: string) => void }) {
  const nt = useNT()
  const locale = useLocale()
  const byId = useParticipants((s) => s.byId)
  const members = membersOf(w, byId)
  const messages = useWhispers((s) => s.byId[w.id])
  const latest = messages?.[messages.length - 1]
  const live = Boolean(useWhispers((s) => s.streaming[w.id]))
  if (members.length < 2) return null
  const preview = latest?.body?.replace(/\s+/g, ' ').trim() || w.about || nt('whispers.noPreview')
  const title = whisperTitle(w, members, nt)
  const target = href({ section: 'whispers', id: w.id })
  return (
    <a className="nx-whispers__row" data-selected={selected || undefined} href={target}
      onClick={(event) => { linkClick(event); if (event.defaultPrevented) onOpen(w.id) }}>
      <span className="nx-whispers__row-avatars">
        {members.length > 2 ? <AvatarStack ps={members} size={30} max={3} /> : <><Avatar p={members[0]} size={34} /><Avatar p={members[1]} size={34} /></>}
      </span>
      <span className="nx-whispers__row-main">
        <span className="nx-whispers__row-title"><b>{title}</b>{live && <span className="nx-whispers__live"><i />{nt('whispers.live')}</span>}</span>
        <span className="nx-whispers__preview">{preview}</span>
      </span>
      <span className="nx-whispers__row-meta"><time className="nx-mono" dateTime={w.updatedAt}>{listStamp(w.updatedAt, locale)}</time>{w.msgCount > 0 && <span className="nx-whispers__count nx-mono">{w.msgCount}</span>}</span>
    </a>
  )
})

function WhisperList({ route, onOpen }: { route: SectionProps['route']; onOpen: (id: string) => void }) {
  const nt = useNT()
  const list = useWhispers((s) => s.list)
  const loaded = useWhispers((s) => s.loaded)
  useEffect(() => { if (!loaded) void useWhispers.getState().loadList() }, [loaded])
  return (
    <section className="nx-whispers__list" aria-label={nt('whispers.title')}>
      <header className="nx-whispers__list-head">
        <div className="nx-whispers__title-line"><IWhisper /><h1>{nt('whispers.title')}</h1><span className="nx-badge nx-badge--muted nx-mono">{list.length}</span></div>
        <p>{nt('whispers.subtitle')}</p>
      </header>
      <div className="nx-scroll nx-whispers__rows" aria-busy={!loaded || undefined}>
        {!loaded && <div className="nx-whispers__state"><Spinner large /><span>{nt('whispers.loading')}</span></div>}
        {loaded && list.length === 0 && <div className="nx-whispers__state"><IWhisper /><b>{nt('whispers.emptyTitle')}</b><span>{nt('whispers.emptyBody')}</span></div>}
        {list.map((w) => <WhisperRow key={w.id} w={w} selected={route.id === w.id} onOpen={onOpen} />)}
      </div>
    </section>
  )
}

function MessageRow({ msg, members }: { msg: ApiWhisperMessage; members: Participant[] }) {
  const locale = useLocale()
  const author = members.find((p) => p.id === msg.authorId)
  if (msg.kind === 'system') return <SystemRow msg={msg} animate={false} />
  if (msg.kind === 'tool' || !msg.body.trim() || !author) return null
  const mine = msg.authorId === members[1]?.id
  const at = validDate(msg.createdAt)
  return (
    <div className="nx-msg nx-whispers__message" data-mine={mine || undefined}>
      <div className="nx-msg__gutter">{!mine && <Avatar p={author} size={28} />}</div>
      <div className="nx-msg__col">
        <div className="nx-msg__name"><span>{author.name}</span><time className="nx-mono" dateTime={at.toISOString()}>{clock(at, locale)}</time></div>
        <div className="nx-msg__row"><div className="nx-bubble"><RichBody body={msg.body} conversationId={msg.conversationId} /></div></div>
      </div>
    </div>
  )
}

function Transcript({ whisper }: { whisper: ApiWhisper }) {
  const nt = useNT()
  const byId = useParticipants((s) => s.byId)
  // zustand v5 compares snapshots by identity: an object built in the selector
  // is new on every read and re-renders forever without useShallow.
  const state = useWhispers(useShallow((s) => ({ byId: s.byId, streaming: s.streaming })))
  const locale = useLocale()
  const members = membersOf(whisper, byId)
  const messages = useMemo(() => whisperMessages(state as WhispersStateLike, whisper.id).filter((m) => m.kind !== 'tool'), [state, whisper.id])
  const live = state.streaming[whisper.id]
  const liveAuthor = live ? members.find((p) => p.id === live.authorId) : undefined
  useEffect(() => { void useWhispers.getState().loadMessages(whisper.id) }, [whisper.id])
  const title = whisperTitle(whisper, members, nt)
  if (members.length < 2) return <div className="nx-whispers__state"><span>{nt('whispers.membersLoading')}</span></div>
  return (
    <section className="nx-whispers__room" aria-label={title}>
      <header className="nx-whispers__room-head">
        <div className="nx-whispers__room-avatars"><Avatar p={members[0]} size={38} /><Avatar p={members[1]} size={38} />{members.length > 2 && <AvatarStack ps={members.slice(2)} size={26} max={2} />}</div>
        <div className="nx-whispers__room-copy"><h2>{title}</h2><p>{whisper.about || nt('whispers.privateThread')} · {nt('whispers.started', { time: clock(validDate(whisper.createdAt), locale) })}</p></div>
        <span className="nx-chip"><IInfo />{nt('whispers.readOnly')}</span>
      </header>
      <div className="nx-whispers__observer"><IInfo />{nt('whispers.observerHint')}</div>
      <div className="nx-transcript nx-whispers__transcript">
        {messages.length === 0 && !live ? <div className="nx-whispers__state"><IWhisper /><b>{nt('whispers.noMessages')}</b><span>{nt('whispers.noMessagesBody')}</span></div> : <div className="nx-whispers__stream"><Virtuoso data={messages} className="nx-transcript__scroller nx-scroll" followOutput="smooth" itemContent={(_, msg) => <MessageRow msg={msg} members={members} />} />{live && liveAuthor && <div className="nx-msg nx-whispers__message"><div className="nx-msg__gutter"><Avatar p={liveAuthor} size={28} /></div><div className="nx-msg__col"><div className="nx-msg__name"><span>{liveAuthor.name}</span><span className="nx-shimmer">{nt('whispers.writing')}</span></div><div className="nx-msg__row"><div className="nx-bubble"><span className="nx-dots"><i /><i /><i /></span>{live.body && <span className="nx-whispers__live-text"><RichBody body={live.body} conversationId={whisper.id} /></span>}</div></div></div></div>}</div>}
      </div>
    </section>
  )
}

function Room({ route }: SectionProps) {
  const nt = useNT()
  const whisper = useWhispers((s) => s.list.find((w) => w.id === route.id))
  if (!route.id || !whisper) return <div className="nx-whispers__empty"><IWhisper /><b>{nt('whispers.pickTitle')}</b><span>{nt('whispers.pickBody')}</span></div>
  return <Transcript whisper={whisper} />
}

export default function WhispersSection(props: SectionProps) {
  const { route, layout } = props
  const nt = useNT()
  const open = (id: string) => navigate(href({ section: 'whispers', id }))
  if (layout === 'stack') {
    if (route.id) return <div className="nx-whispers nx-whispers--stack"><header className="nx-whispers__stack-head"><IconButton label={nt('whispers.back')} onClick={() => goBack(href({ section: 'whispers' }))}><IChevronLeft /></IconButton><span>{nt('whispers.title')}</span></header><Room {...props} /></div>
    return <div className="nx-whispers nx-whispers--stack"><WhisperList route={route} onOpen={open} /></div>
  }
  return <div className="nx-whispers"><WhisperList route={route} onOpen={open} /><Room {...props} /></div>
}
