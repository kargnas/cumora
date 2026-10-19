import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useApp } from '@/stores/app'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { api, ws, type ApiConveneSession, type ApiConveneTranscript, type WsEvent } from '@/api/client'
import type { Participant } from '@/types'
import { RichBody } from '@/components/Message'
import { useLocale } from '@/lib/i18n'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { authorOf } from '../../chat/deletedAuthor'
import { clock } from '../../format'
import { href, navigate } from '../../router'
import type { SectionProps } from '../types'
import { Avatar } from '../../ui/Avatar'
import { Spinner } from '../../ui/primitives'
import { IConvene, IStop } from '../../ui/icons'
import './convene.css'

interface ConveneState { session: ApiConveneSession | null; transcript: ApiConveneTranscript[]; loading: boolean; error: string | null }

function safeDate(raw: string): Date {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function isSession(value: unknown): value is ApiConveneSession {
  if (!value || typeof value !== 'object') return false
  const x = value as Partial<ApiConveneSession>
  return typeof x.id === 'string' && typeof x.conversation_id === 'string' && typeof x.title === 'string'
}

function TranscriptEntry({ entry, byId, compact = false }: { entry: ApiConveneTranscript; byId: Record<string, Participant>; compact?: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  if (entry.kind === 'decision' && entry.decision) {
    return <article className={compact ? 'nx-convene__decision nx-convene__decision--compact' : 'nx-convene__decision'}><span className="nx-chip">{nt('convene.decision')}</span><h3>{entry.decision.headline}</h3><p>{entry.decision.body}</p></article>
  }
  const author = authorOf(byId, entry.authorId, nt)
  if (!author) return null
  return (
    <article className={compact ? 'nx-convene__entry nx-convene__entry--compact' : 'nx-convene__entry'}>
      {!compact && <Avatar p={author} size={30} presence />}
      <div className="nx-convene__entry-body"><div className="nx-convene__entry-meta"><b>{author.name}</b><time className="nx-mono" dateTime={entry.createdAt}>{clock(safeDate(entry.createdAt), locale)}</time></div><div className="nx-convene__entry-text"><RichBody body={entry.body} /></div></div>
    </article>
  )
}

function Participants({ people, transcript }: { people: Participant[]; transcript: ApiConveneTranscript[] }) {
  const nt = useNT()
  const lastAuthor = transcript[transcript.length - 1]?.authorId
  return <section className="nx-convene__tiles" aria-label={nt('convene.participants')}>
    {people.map((p) => {
      const speaking = p.id === lastAuthor
      const status = speaking ? nt('convene.statusSpeaking') : p.status === 'thinking' ? nt('convene.statusThinking') : p.status === 'working' ? nt('convene.statusWorking') : nt('convene.statusListening')
      return <article className="nx-convene__tile" data-speaking={speaking || undefined} key={p.id}><Avatar p={p} size={34} presence /><div className="nx-convene__tile-copy"><b>{p.name}</b><span>{p.role || p.kind}</span><small><i />{status}</small></div></article>
    })}
  </section>
}

function Empty({ title, body, action, busy }: { title: string; body: string; action?: React.ReactNode; busy?: boolean }) {
  return <section className="nx-convene__empty"><IConvene /><h1>{title}</h1><p>{body}</p>{busy ? <Spinner large /> : action}</section>
}

export default function ConveneSection({ route }: SectionProps) {
  const nt = useNT()
  const locale = useLocale()
  const selectedId = useApp((s) => s.selectedConversationId) || route.search.get('conversation')
  const conversations = useConversations((s) => s.list)
  const byId = useParticipants((s) => s.byId)
  const conversation = useMemo(() => conversations.find((c) => c.id === selectedId), [conversations, selectedId])
  const [state, setState] = useState<ConveneState>({ session: null, transcript: [], loading: Boolean(selectedId), error: null })
  const sessionRef = useRef<ApiConveneSession | null>(null)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  sessionRef.current = state.session

  useEffect(() => {
    let cancelled = false
    if (!selectedId) { setState({ session: null, transcript: [], loading: false, error: null }); return () => { cancelled = true } }
    setState((s) => ({ ...s, loading: true, error: null }))
    void api.getActiveConvene(selectedId).then(async (session) => {
      if (cancelled) return
      if (!session) { setState({ session: null, transcript: [], loading: false, error: null }); return }
      const transcript = await api.getConveneTranscript(session.id)
      if (!cancelled) setState({ session, transcript, loading: false, error: null })
    }).catch((error: unknown) => { if (!cancelled) setState({ session: null, transcript: [], loading: false, error: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    const off = ws.on((event: WsEvent) => {
      if (event.type !== 'convene' || event.conversationId !== selectedRef.current) return
      if (event.kind === 'started' && isSession(event.data)) { setState({ session: event.data, transcript: [], loading: false, error: null }); return }
      if (event.kind === 'transcript' && event.data && sessionRef.current?.id === event.sessionId) {
        const entry = event.data as ApiConveneTranscript
        setState((s) => s.transcript.some((item) => item.id === entry.id) ? s : { ...s, transcript: [...s.transcript, entry] })
      }
      if (event.kind === 'ended' && sessionRef.current?.id === event.sessionId) setState((s) => s.session ? { ...s, session: { ...s.session, state: 'ended' } } : s)
    })
    return off
  }, [])

  const people = useMemo(() => (conversation?.members ?? []).map((id) => byId[id]).filter((p): p is Participant => Boolean(p)), [conversation?.members, byId])
  const start = async () => {
    if (!selectedId || !conversation) return
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const session = await api.startConvene(selectedId, conversation.title || nt('convene.sessionTitleFallback'))
      haptic('success')
      navigate(href({ section: 'convene', params: { conversation: selectedId } }))
      setState({ session, transcript: [], loading: false, error: null })
    } catch (error: unknown) {
      haptic('error')
      setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  if (!selectedId || !conversation) return <div className="nx-convene"><Empty title={nt('convene.pickConvo')} body={nt('convene.pickConvoSub')} /></div>
  if (state.loading && !state.session) return <div className="nx-convene"><Empty title={nt('convene.loading')} body={nt('convene.loadingBody')} busy /></div>
  if (state.error && !state.session) return <div className="nx-convene"><Empty title={nt('convene.loadFailed')} body={state.error} action={<button type="button" className="nx-btn nx-btn--outline" onClick={() => navigate(href({ section: 'convene', params: { conversation: selectedId } }))}>{nt('convene.retry')}</button>} /></div>
  if (!state.session || state.session.state === 'ended') return <div className="nx-convene"><Empty title={state.session ? nt('convene.lastWrapped') : nt('convene.noLive')} body={nt('convene.ctaSub', { title: conversation.title })} busy={state.loading} action={!state.loading && <button type="button" className="nx-btn nx-btn--primary" onClick={() => void start()}><IConvene />{nt('convene.startBtn')}</button>} /></div>

  return <div className="nx-convene nx-convene--live">
    <header className="nx-convene__head"><span className="nx-convene__live"><i />{nt('convene.live')}</span><div className="nx-convene__head-title"><b>{state.session.title}</b>{state.session.flair && <span>{state.session.flair}</span>}</div><time className="nx-mono">{nt('convene.startedAt', { time: clock(safeDate(state.session.started_at), locale) })}</time></header>
    <main className="nx-convene__main"><Participants people={people} transcript={state.transcript} /><div className="nx-convene__transcript"><Virtuoso data={state.transcript} className="nx-scroll" followOutput="smooth" itemContent={(_, entry) => <TranscriptEntry entry={entry} byId={byId} />} /></div></main>
    <aside className="nx-convene__side"><div className="nx-convene__side-head"><b>{nt('convene.transcriptTitle')}</b><span>{nt('convene.entries', { count: state.transcript.length })}</span></div><div className="nx-convene__side-list nx-scroll">{state.transcript.map((entry) => <TranscriptEntry key={entry.id} entry={entry} byId={byId} compact />)}</div></aside>
    <button type="button" className="nx-convene__stop" title={nt('convene.stopLabel')} onClick={() => navigate(href({ section: 'chats', id: selectedId }))}><IStop /></button>
  </div>
}
