/**
 * Transcript. Rendering budget rules:
 *  - Virtuoso mounts only what is near the viewport; rows are memoized on the
 *    message object, which the store replaces only when that message changes.
 *  - Streaming text and typing bubbles live in the list footer and subscribe
 *    to their own slice, so a token stream re-renders one bubble, not the list.
 *  - Entrance motion is CSS on transform/opacity/clip-path and plays once per
 *    message per session, so scrolling back never replays it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useMessages, toggleReaction, retryFailedMessage, discardFailedMessage, VIRTUOSO_FIRST_INDEX_BASE } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import { copyText } from '@/lib/clipboard'
import {
  RichBody, SystemRow, artifactKey, artifactRefsForMessage,
  DocumentArtifactCard, BoardArtifactCard, CardArtifactCard, CalendarArtifactCard,
} from '@/components/Message'
import { PollBubble } from '@/components/PollBubble'
import { LinkPreview, firstUrlInBody } from '@/components/LinkPreview'
import { ImageViewer } from '@/components/ImageViewer'
import type { Message, Participant } from '@/types'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { href, navigate, getRoute, withRoute } from '../router'
import { bytes, clock, dayLabel, elapsed } from '../format'
import { useHold, useNow } from '../hooks'
import { Avatar } from '../ui/Avatar'
import { IconButton, Menu, Spinner, useMenu, type MenuEntry } from '../ui/primitives'
import { IArrowDown, ICopy, IDownload, IFile, IMore, IReply, ISpark, IThread, IWhisper } from '../ui/icons'
import { buildItems, type Item, type Pos } from './model'

const EMPTY: Message[] = []
const QUICK = ['👍', '❤️', '😂', '👀', '✅', '🔥']

/** When each row was first shown, per conversation. A row animates only
 *  inside its first ENTRANCE_MS, so a re-render mid-animation keeps playing
 *  and a remount after scrolling never replays it. */
const firstSeen = new Map<string, Map<string, number>>()
const ENTRANCE_MS = 700
function seenMap(convoId: string): Map<string, number> {
  let m = firstSeen.get(convoId)
  if (!m) { m = new Map(); firstSeen.set(convoId, m) }
  return m
}
/** Message ids the user already watched stream in. Their final row must not
 *  fade in again: the text was on screen the whole time. */
const streamed = new Set<string>()

function isFresh(seen: Map<string, number>, key: string): boolean {
  const t = seen.get(key)
  if (t === undefined) { seen.set(key, performance.now()); return true }
  return performance.now() - t < ENTRANCE_MS
}

/* ── Reactions ──────────────────────────────────────────────────────── */
function Reactions({ msg, mine }: { msg: Message; mine: boolean }) {
  const list = msg.reactions ?? []
  if (list.length === 0) return null
  return (
    <div className={mine ? 'nx-reacts nx-reacts--mine' : 'nx-reacts'}>
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className="nx-react"
          data-mine={r.mine || undefined}
          data-haptic
          aria-pressed={!!r.mine}
          onClick={() => void toggleReaction(msg.id, r.emoji)}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="nx-mono">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

/* ── Attachments ────────────────────────────────────────────────────── */
function Attachment({ a }: { a: NonNullable<Message['attachment']> }) {
  const [viewer, setViewer] = useState(false)
  if (a.kind === 'img' && a.url) {
    return (
      <>
        <button type="button" className="nx-att-img" onClick={() => setViewer(true)} aria-label={a.name}>
          {/* Fixed box: the server stores no dimensions, and an image that
              grows on load would shove every row below it in the list. */}
          <img src={a.url} alt={a.name} loading="lazy" decoding="async" draggable={false} />
        </button>
        {viewer && <ImageViewer src={a.url} name={a.name} onClose={() => setViewer(false)} />}
      </>
    )
  }
  const body = (
    <>
      <span className="nx-att-file__icon"><IFile /></span>
      <span className="nx-att-file__text">
        <span className="nx-att-file__name">{a.name}</span>
        <span className="nx-att-file__meta nx-mono">{[a.mime?.split('/')[1], a.size ? bytes(a.size) : null].filter(Boolean).join(' · ')}</span>
      </span>
      {a.url && <IDownload className="nx-att-file__dl" />}
    </>
  )
  return a.url
    ? <a className="nx-att-file" href={a.url} download={a.name} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="nx-att-file">{body}</div>
}

function Artifacts({ msg }: { msg: Message }) {
  const refs = useMemo(() => artifactRefsForMessage(msg), [msg])
  if (refs.length === 0) return null
  return (
    <div className="nx-artifacts">
      {refs.map((ref) => ref.type === 'document'
        ? <DocumentArtifactCard key={artifactKey(ref)} id={ref.id} conversationId={msg.conversationId} />
        : ref.type === 'board'
          ? <BoardArtifactCard key={artifactKey(ref)} id={ref.id} />
          : ref.type === 'card'
            ? <CardArtifactCard key={artifactKey(ref)} id={ref.id} />
            : <CalendarArtifactCard key={artifactKey(ref)} id={ref.id} />)}
    </div>
  )
}

/* ── Bubble ─────────────────────────────────────────────────────────── */
interface BubbleProps {
  /** In-room search: 'match' for every hit, 'current' for the focused one. */
  hl?: 'match' | 'current'
  msg: Message
  author: Participant | undefined
  mine: boolean
  pos: Pos
  showName: boolean
  fresh: boolean
  at: Date
}

export const Bubble = memo(function Bubble({ msg, author, mine, pos, showName, fresh, at, hl }: BubbleProps) {
  const nt = useNT()
  const locale = useLocale()
  const menu = useMenu()
  const hold = useHold((x, y) => menu.openAt({ x, y }))
  const hasText = msg.body.trim().length > 0 && msg.kind !== 'poll'
  const linkUrl = hasText && msg.kind === 'text' ? firstUrlInBody(msg.body) : null
  const tail = pos === 'single' || pos === 'last'
  const quote = msg.quoted
  const quoteAuthor = useParticipants((s) => (quote ? s.byId[quote.authorId]?.name : undefined))
  // Selects a string, so status churn on participants does not re-render the bubble.
  const quoteText = useParticipants((s) => quote?.body.replace(/@([A-Za-z][\w-]*)/g, (m, id: string) => (s.byId[id] ? `@${s.byId[id].name}` : m)))

  const react = (emoji: string) => { void toggleReaction(msg.id, emoji) }
  const reply = () => useApp.getState().setReplyingTo(msg.conversationId, msg.id)
  const thread = () => navigate(withRoute(getRoute(), { threadId: msg.id, peek: null }))
  const entries: MenuEntry[] = [
    { key: 'reply', label: nt('msg.reply'), icon: <IReply />, onSelect: reply },
    { key: 'thread', label: nt('msg.thread'), icon: <IThread />, onSelect: thread },
    ...(hasText ? [{ key: 'copy', label: nt('msg.copy'), icon: <ICopy />, onSelect: () => void copyText(msg.body) }] : []),
  ]

  return (
    <div
      id={`m-${msg.id}`}
      className="nx-msg"
      data-mine={mine || undefined}
      data-pos={pos}
      data-fresh={fresh ? (mine ? 'send' : 'reveal') : undefined}
      data-pending={msg.pending || undefined}
      data-hl={hl}
    >
      <div className="nx-msg__gutter" aria-hidden>
        {!mine && tail && author && <Avatar p={author} size={28} />}
      </div>
      <div className="nx-msg__col">
        {showName && author && (
          <div className="nx-msg__name">
            <span>{author.name}</span>
            <time className="nx-mono" dateTime={at.toISOString()}>{clock(at, locale)}</time>
          </div>
        )}
        <div className="nx-msg__row" {...hold}>
          <div className="nx-bubble" data-kind={msg.kind}>
            {quote && (
              <button type="button" className="nx-quote" onClick={() => useApp.getState().jumpToMessage(quote.id)}>
                <span className="nx-quote__who">{quoteAuthor ?? quote.authorName ?? nt('msg.someone')}</span>
                <span className="nx-quote__text">{quoteText}</span>
              </button>
            )}
            {msg.email?.subject && <div className="nx-bubble__subject">{msg.email.subject}</div>}
            {hasText && <div className="nx-bubble__text"><RichBody body={msg.body} conversationId={msg.conversationId} /></div>}
            {msg.kind === 'poll' && <PollBubble msg={msg} />}
            {msg.attachment && <Attachment a={msg.attachment} />}
          </div>
          <div className="nx-msg__tools" role="toolbar" aria-label={nt('msg.actions')}>
            {QUICK.slice(0, 3).map((e) => (
              <button key={e} type="button" className="nx-msg__quick" onClick={() => react(e)} aria-label={nt('msg.reactWith', { emoji: e })}>{e}</button>
            ))}
            <IconButton small label={nt('msg.reply')} onClick={reply}><IReply /></IconButton>
            <IconButton small label={nt('msg.thread')} onClick={thread}><IThread /></IconButton>
            <IconButton small label={nt('msg.more')} onClick={(e) => menu.toggleFrom(e.currentTarget, mine ? 'end' : 'start')}><IMore /></IconButton>
          </div>
        </div>
        {linkUrl && <div className="nx-msg__extra"><LinkPreview url={linkUrl} /></div>}
        <Artifacts msg={msg} />
        <Reactions msg={msg} mine={mine} />
        {(msg.replyCount ?? 0) > 0 && (
          <button type="button" className="nx-msg__thread" onClick={thread}>
            <IThread />
            {nt(msg.replyCount === 1 ? 'msg.oneReply' : 'msg.replies', { n: msg.replyCount ?? 0 })}
          </button>
        )}
        {(msg.failed || msg.unconfirmed) && (
          <div className="nx-msg__failed">
            <span>{msg.unconfirmed ? nt('msg.unconfirmed') : nt('msg.failed')}</span>
            <button type="button" onClick={() => { haptic('sent'); void retryFailedMessage(msg.conversationId, msg.id) }}>{nt('msg.retry')}</button>
            <button type="button" onClick={() => discardFailedMessage(msg.conversationId, msg.id)}>{nt('msg.discard')}</button>
          </div>
        )}
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={entries}
        header={
          <div className="nx-menu__reacts">
            {QUICK.map((e) => (
              <button key={e} type="button" onClick={() => { react(e); menu.close() }} aria-label={nt('msg.reactWith', { emoji: e })}>{e}</button>
            ))}
          </div>
        }
      />
    </div>
  )
})

/* ── Work runs (tool/thought messages) ──────────────────────────────── */
function WorkChip({ item, author }: { item: Extract<Item, { type: 'work' }>; author: Participant | undefined }) {
  const nt = useNT()
  const tools = item.msgs.filter((m) => m.kind === 'tool').length
  const last = item.msgs[item.msgs.length - 1]
  const label = last.kind === 'tool' && last.tool ? last.tool.name : last.body.split('\n')[0]
  return (
    <div className="nx-msg nx-msg--work">
      <div className="nx-msg__gutter" aria-hidden />
      <button
        type="button"
        className="nx-work"
        onClick={() => navigate(withRoute(getRoute(), { panel: 'activity', peek: null, threadId: null }))}
      >
        <ISpark aria-hidden />
        <span className="nx-work__who">{author?.name ?? nt('msg.someone')}</span>
        <span className="nx-work__what">{label}</span>
        <span className="nx-work__count nx-mono">{tools > 0 ? nt('msg.toolCount', { n: tools }) : nt('msg.thoughtCount', { n: item.msgs.length })}</span>
      </button>
    </div>
  )
}

function WhisperLine({ msg }: { msg: Message }) {
  const nt = useNT()
  const names = useParticipants(useShallow((s) => (msg.whisperLink?.pair ?? []).map((id) => s.byId[id]?.name ?? '?')))
  if (!msg.whisperLink) return null
  return (
    <a
      className="nx-line nx-line--whisper"
      href={href({ section: 'whispers' })}
      onClick={(e) => { e.preventDefault(); navigate(href({ section: 'whispers' })) }}
    >
      <IWhisper aria-hidden />
      <span>{nt('msg.whisper', { a: names[0], b: names[1], n: msg.whisperLink.count })}</span>
    </a>
  )
}

/* ── Live footer: typing → streaming → final message ───────────────── */
function LiveBubble({ authorId, body }: { authorId: string; body: string | null }) {
  const nt = useNT()
  const p = useParticipants((s) => s.byId[authorId])
  const startRef = useRef(Date.now())
  // Prefer the server's status clock: it survives a reload mid-turn.
  const since = p?.statusUpdatedAt && (p.status === 'working' || p.status === 'thinking')
    ? Math.min(new Date(p.statusUpdatedAt).getTime(), startRef.current)
    : startRef.current
  const now = useNow(body === null)
  if (!p) return null
  return (
    <div className="nx-msg nx-msg--live" data-fresh="reveal">
      <div className="nx-msg__gutter"><Avatar p={p} size={28} presence /></div>
      <div className="nx-msg__col">
        <div className="nx-msg__row">
          <div className="nx-bubble" data-live={body === null ? 'typing' : 'stream'}>
            {body === null ? (
              <span className="nx-typing">
                <span className="nx-dots" aria-hidden><i /><i /><i /></span>
                <span className="nx-shimmer">{nt('msg.working', { name: p.name })}</span>
                <span className="nx-typing__time nx-mono">{elapsed(now - since)}</span>
              </span>
            ) : (
              <div className="nx-bubble__text nx-stream">{body}<span className="nx-caret" aria-hidden /></div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LiveFooter({ convoId, onChange }: { convoId: string; onChange: (grew: boolean) => void }) {
  const me = useMe()
  const streaming = useMessages((s) => s.streaming)
  const typing = useMessages((s) => s.typing[convoId])
  const live = useMemo(() => {
    const parsed = Object.entries(streaming)
      .filter(([, x]) => x.conversationId === convoId)
      .map(([id, x]) => { streamed.add(id); return x })
    const streamingAuthors = new Set(parsed.map((s) => s.authorId))
    const typers = (typing ?? []).filter((id) => id !== me && !streamingAuthors.has(id))
    return [...parsed.map((s) => ({ key: s.authorId, authorId: s.authorId, body: s.body as string | null })),
      ...typers.map((id) => ({ key: id, authorId: id, body: null as string | null }))]
  }, [streaming, convoId, typing, me])
  const sig = live.map((l) => `${l.key}:${l.body?.length ?? -1}`).join('|')
  const count = useRef(0)
  useEffect(() => {
    onChange(live.length !== count.current)
    count.current = live.length
  }, [sig, live.length, onChange])
  if (live.length === 0) return null
  return <>{live.map((l) => <LiveBubble key={l.key} authorId={l.authorId} body={l.body} />)}</>
}

/* ── List ───────────────────────────────────────────────────────────── */
interface ListContext {
  convoId: string
  bottomInset: number
  onLiveChange: (grew: boolean) => void
  loadingOlder: boolean
  hasMore: boolean
  empty: boolean
  beginning: string
}

// Module-level so Virtuoso never sees new component types: a fresh Footer
// function per render would remount the live bubbles and reset their clocks.
const LIST_COMPONENTS = {
  Header: ({ context }: { context?: ListContext }) => (
    <div className="nx-transcript__head">
      {context?.loadingOlder ? <Spinner /> : context && !context.hasMore && !context.empty ? <span>{context.beginning}</span> : null}
    </div>
  ),
  Footer: ({ context }: { context?: ListContext }) => (
    <div style={{ paddingBottom: context?.bottomInset ?? 0 }}>
      {context && <LiveFooter convoId={context.convoId} onChange={context.onLiveChange} />}
    </div>
  ),
}
export interface Find {
  q: string
  /** 0 = newest hit; larger = older. */
  index: number
  onCount: (n: number) => void
}

export function MessageList({ convoId, group, bottomInset, find }: { convoId: string; group: boolean; bottomInset: number; find?: Find }) {
  const nt = useNT()
  const locale = useLocale()
  const me = useMe()
  const raw = useMessages((s) => s.byConvo[convoId] ?? EMPTY)
  const loaded = useMessages((s) => s.loaded.has(convoId))
  const error = useMessages((s) => s.errors[convoId])
  const hasMore = useMessages((s) => s.hasMoreOlder[convoId] ?? false)
  const loadingOlder = useMessages((s) => s.loadingOlder.has(convoId))
  const byId = useParticipants((s) => s.byId)
  const ref = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const items = useMemo(() => buildItems(raw, me), [raw, me])

  // Messages present at open never animate; anything after does, once.
  const seen = seenMap(convoId)
  const firstPaint = useRef(true)
  if (firstPaint.current && items.length > 0) {
    for (const it of items) if (!seen.has(it.key)) seen.set(it.key, -Infinity)
    firstPaint.current = false
  }

  // Virtuoso keeps its scroll anchor on prepend only if firstItemIndex drops
  // by exactly the number of rows added above. Items are a filtered view of
  // the store, so anchor on the first row we ever showed and count how far
  // it has moved down.
  const anchorKey = useRef<string | null>(null)
  if (anchorKey.current === null && items.length > 0) anchorKey.current = items[0].key
  let anchorIndex = anchorKey.current ? items.findIndex((it) => it.key === anchorKey.current) : 0
  if (anchorIndex < 0) {
    anchorKey.current = items[0]?.key ?? null
    anchorIndex = 0
  }
  const firstItemIndex = VIRTUOSO_FIRST_INDEX_BASE - anchorIndex

  const onStartReached = useCallback(() => {
    if (hasMore && !loadingOlder) void useMessages.getState().loadOlder(convoId)
  }, [convoId, hasMore, loadingOlder])

  // Typing/streaming bubbles grow the footer, which Virtuoso's followOutput
  // does not watch; keep the bottom pinned ourselves while the user is there.
  // A new bubble glides into view; token growth follows instantly so the
  // text never lags behind the scroll animation.
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  const scroller = useRef<HTMLElement | null>(null)
  const onLiveChange = useCallback((grew: boolean) => {
    if (!atBottomRef.current) return
    requestAnimationFrame(() => {
      const el = scroller.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: grew ? 'smooth' : 'auto' })
    })
  }, [])

  // Quote taps, palette hits and `#N` chips all route through useApp.
  const pendingJump = useApp((s) => s.pendingJumpMessageId)
  useEffect(() => {
    if (!pendingJump) return
    const index = items.findIndex((it) => it.type !== 'work' && it.msg.id === pendingJump)
    if (index < 0) return
    useApp.getState().clearPendingJump()
    ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    const deadline = Date.now() + 1200
    const flash = () => {
      const el = document.getElementById(`m-${pendingJump}`)
      if (el) {
        el.classList.add('nx-flash')
        window.setTimeout(() => el.classList.remove('nx-flash'), 1400)
      } else if (Date.now() < deadline) window.setTimeout(flash, 60)
    }
    window.setTimeout(flash, 80)
  }, [pendingJump, items])

  // In-room search over the loaded transcript, newest hit first.
  const q = find?.q.trim().toLowerCase() ?? ''
  const hits = useMemo(() => {
    if (!q) return [] as string[]
    const out: string[] = []
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.type === 'msg' && it.msg.body.toLowerCase().includes(q)) out.push(it.key)
    }
    return out
  }, [items, q])
  const onCount = find?.onCount
  useEffect(() => { onCount?.(hits.length) }, [hits.length, onCount])
  const currentHit = hits.length > 0 ? hits[Math.min(find?.index ?? 0, hits.length - 1)] : null
  const hitSet = useMemo(() => new Set(hits), [hits])
  useEffect(() => {
    if (!currentHit) return
    const index = items.findIndex((it) => it.key === currentHit)
    if (index >= 0) ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    // Keyed on the hit alone: new messages arriving must not yank the view back.
  }, [currentHit])

  const renderItem = useCallback((_: number, it: Item): ReactNode => {
    const sep = it.day ? <div className="nx-day"><span>{dayLabel(it.day, locale, nt('msg.today'), nt('msg.yesterday'))}</span></div> : null
    const fresh = isFresh(seen, it.key) && !(it.type !== 'work' && streamed.has(it.msg.id))
    if (it.type === 'work') return <>{sep}<WorkChip item={it} author={byId[it.authorId]} /></>
    if (it.type === 'line') {
      return (
        <>
          {sep}
          {it.msg.kind === 'whisper-link' ? <WhisperLine msg={it.msg} /> : <div className="nx-line"><SystemRow msg={it.msg} animate={false} /></div>}
        </>
      )
    }
    const showName = !it.mine && (it.pos === 'single' || it.pos === 'first') && (group || it.day !== null)
    return (
      <>
        {sep}
        <Bubble
          msg={it.msg}
          author={byId[it.msg.authorId]}
          mine={it.mine}
          pos={it.pos}
          showName={showName}
          fresh={fresh}
          at={it.at}
          hl={it.key === currentHit ? 'current' : hitSet.has(it.key) ? 'match' : undefined}
        />
      </>
    )
  }, [byId, group, locale, nt, seen, currentHit, hitSet])

  if (items.length === 0) {
    if (error) return <div className="nx-center"><div className="nx-empty"><b>{nt('msg.loadFailed')}</b><button type="button" className="nx-btn nx-btn--outline" onClick={() => void useMessages.getState().retryLoad(convoId)}>{nt('msg.retry')}</button></div></div>
    if (!loaded) return <TranscriptSkeleton />
  }

  return (
    <div className="nx-transcript">
      <Virtuoso
        ref={ref}
        scrollerRef={(el) => { scroller.current = el instanceof HTMLElement ? el : null }}
        className="nx-transcript__scroller"
        data={items}
        firstItemIndex={firstItemIndex}
        // Open at the newest message with its bottom edge in view, like every messenger.
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        alignToBottom
        followOutput={(bottom) => (bottom ? 'smooth' : false)}
        // Rows also grow after layout (a reaction, a loaded image) with nothing
        // appended, which followOutput ignores; without this the newest row
        // slides under the composer.
        totalListHeightChanged={() => onLiveChange(true)}
        atBottomThreshold={96}
        atBottomStateChange={setAtBottom}
        startReached={onStartReached}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        defaultItemHeight={64}
        computeItemKey={(_, it) => it.key}
        itemContent={renderItem}
        context={{ convoId, bottomInset, onLiveChange, loadingOlder, hasMore, empty: items.length === 0, beginning: nt('msg.beginning') }}
        components={LIST_COMPONENTS}
      />
      <button
        type="button"
        className="nx-to-latest"
        data-show={!atBottom || undefined}
        style={{ bottom: bottomInset + 8 }}
        aria-label={nt('msg.latest')}
        onClick={() => ref.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' })}
      >
        <IArrowDown />
      </button>
    </div>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="nx-transcript nx-transcript--skel" aria-busy="true">
      {[62, 38, 74, 50].map((w, i) => (
        <div key={i} className="nx-msg" data-mine={i === 2 || undefined}>
          <div className="nx-msg__gutter">{i !== 2 && <span className="nx-skel" style={{ width: 28, height: 28, borderRadius: 999 }} />}</div>
          <div className="nx-msg__col"><span className="nx-skel" style={{ width: `${w}%`, height: 36, borderRadius: 18 }} /></div>
        </div>
      ))}
    </div>
  )
}
