import { useEffect, useMemo, useState } from 'react'
import { EventEditor } from '@/components/EventEditor'
import { useDocuments } from '@/stores/documents'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { useAuth } from '@/stores/auth'
import { useLocale } from '@/lib/i18n'
import { MobileCalendar } from '@/mobile/MobileCalendar'
import { listStamp } from '../../format'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { href, navigate, type Route } from '../../router'
import type { SectionProps } from '../types'
import { Spinner } from '../../ui/primitives'
import { IBoard, ICalendar, IDoc, IPlus } from '../../ui/icons'
import './library.css'

const TABS = ['documents', 'boards', 'calendar'] as const
type Tab = typeof TABS[number]

function LibraryItems({ tab, route }: { tab: Tab; route: Route }) {
  const nt = useNT()
  const locale = useLocale()
  const documents = useDocuments((s) => s.list)
  const docsLoaded = useDocuments((s) => s.loaded)
  const loadDocs = useDocuments((s) => s.load)
  const boards = useBoards((s) => s.list)
  const boardsLoading = useBoards((s) => s.loadingList)
  const loadBoards = useBoards((s) => s.loadList)
  const byId = useParticipants((s) => s.byId)
  const me = useAuth((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (tab === 'documents') void loadDocs().catch((e) => setError(String(e))) }, [loadDocs, tab])
  useEffect(() => { if (tab === 'boards') void loadBoards().catch((e) => setError(String(e))) }, [loadBoards, tab])

  const create = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (tab === 'documents') {
        const doc = await useDocuments.getState().create({ title: nt('library.untitledDocument') })
        haptic('success')
        navigate(href({ section: 'library', peek: { kind: 'doc', id: doc.id }, params: { tab } }))
      } else if (tab === 'boards') {
        const id = await useBoards.getState().createBoard(nt('library.untitledBoard'))
        haptic('success')
        navigate(href({ section: 'library', peek: { kind: 'board', id, cardId: null }, params: { tab } }))
      } else {
        navigate(href({ section: 'library', params: { tab, create: 'event' } }))
      }
    } catch (e) { haptic('error'); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const openDoc = (id: string) => navigate(href({ section: 'library', peek: { kind: 'doc', id }, params: { tab } }))
  const openBoard = (id: string) => navigate(href({ section: 'library', peek: { kind: 'board', id, cardId: null }, params: { tab } }))
  const loading = tab === 'documents' ? !docsLoaded : tab === 'boards' ? boardsLoading && boards.length === 0 : false
  const rows = useMemo(() => tab === 'documents'
    ? documents.map((d) => ({ id: d.id, title: d.title || nt('library.untitledDocument'), sub: `${byId[d.createdBy]?.name ?? (d.createdBy === me?.id ? nt('library.you') : d.createdBy)} · ${listStamp(d.updatedAt, locale)}` }))
    : boards.map((b) => ({ id: b.id, title: b.title || nt('library.untitledBoard'), sub: b.description || `${byId[b.createdBy]?.name ?? (b.createdBy === me?.id ? nt('library.you') : b.createdBy)} · ${listStamp(b.updatedAt, locale)}` })), [tab, documents, boards, byId, me?.id, locale, nt])

  return <>
    {tab !== 'calendar' && <div className="nx-library__list nx-scroll" aria-busy={loading}>
      {loading ? <div className="nx-library__state"><Spinner large label={nt('library.loading')} /></div> : rows.length === 0 ? <div className="nx-library__state"><b>{tab === 'documents' ? nt('library.emptyDocs') : nt('library.emptyBoards')}</b><button type="button" className="nx-btn nx-btn--outline" onClick={() => void create()}>{nt('library.createFirst')}</button></div> : rows.map((row) => <button className="nx-library__row" type="button" key={row.id} onClick={() => tab === 'documents' ? openDoc(row.id) : openBoard(row.id)}>
        <span className="nx-library__item-icon">{tab === 'documents' ? <IDoc /> : <IBoard />}</span><span className="nx-library__item-text"><b>{row.title}</b><small>{row.sub}</small></span><span className="nx-library__chevron">›</span>
      </button>)}
    </div>}
    {tab === 'calendar' && <div className="nx-library__calendar"><MobileCalendar /></div>}
    {error && <div className="nx-library__error" role="alert"><span>{error}</span><button type="button" className="nx-btn nx-btn--sm" onClick={() => { setError(''); if (tab === 'documents') void loadDocs().catch((e) => setError(String(e))); else if (tab === 'boards') void loadBoards().catch((e) => setError(String(e))) }}>{nt('library.retry')}</button></div>}
    <button className="nx-library__add" type="button" aria-label={nt(tab === 'documents' ? 'library.newDocument' : tab === 'boards' ? 'library.newBoard' : 'library.newEvent')} disabled={busy} onClick={() => void create()}>{busy ? <Spinner /> : <IPlus />}</button>
    {route.search.get('create') === 'event' && tab === 'calendar' && <EventEditor event={null} onClose={() => navigate(href({ section: 'library', params: { tab } }))} />}
  </>
}

export default function LibrarySection({ route }: SectionProps) {
  const nt = useNT()
  const tab = (TABS.includes(route.search.get('tab') as Tab) ? route.search.get('tab') : 'documents') as Tab
  const icons = { documents: <IDoc />, boards: <IBoard />, calendar: <ICalendar /> }
  const labels = { documents: nt('library.documents'), boards: nt('library.boards'), calendar: nt('library.calendar') }
  return <section className="nx-library">
    <header className="nx-library__head"><div><h1>{nt('library.title')}</h1><p>{nt('library.subtitle')}</p></div></header>
    <nav className="nx-library__tabs" aria-label={nt('library.tabs')}>
      {TABS.map((key) => <button type="button" key={key} aria-current={tab === key ? 'page' : undefined} className="nx-library__tab" onClick={() => navigate(href({ section: 'library', params: { tab: key } }))}>{icons[key]}{labels[key]}</button>)}
    </nav>
    <LibraryItems key={tab} tab={tab} route={route} />
  </section>
}
