import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { DocumentEditor } from '@/components/DocumentEditor'
import { useDocuments } from '@/stores/documents'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { useLocale } from '@/lib/i18n'
import type { ApiDocument } from '@/api/client'
import { listStamp } from '../../format'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { goBack, href, linkClick, navigate, type Route } from '../../router'
import type { SectionProps } from '../types'
import { IconButton, Spinner } from '../../ui/primitives'
import { IDoc, IPlus, ISearch, ITrash } from '../../ui/icons'
import './docs.css'

function DocsList({ route }: { route: Route }) {
  const nt = useNT()
  const locale = useLocale()
  const documents = useDocuments((s) => s.list)
  const loaded = useDocuments((s) => s.loaded)
  const load = useDocuments((s) => s.load)
  const create = useDocuments((s) => s.create)
  const remove = useDocuments((s) => s.remove)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const q = route.search.get('q') ?? ''
  const sort = route.search.get('sort') ?? 'updated'

  useEffect(() => { void load().catch((e) => setError(String(e))) }, [load])
  const rows = useMemo(() => {
    const filtered = documents.filter((d) => (d.title || '').toLocaleLowerCase().includes(q.toLocaleLowerCase()))
    return filtered.sort((a, b) => sort === 'title' ? (a.title || '').localeCompare(b.title || '') : b.updatedAt.localeCompare(a.updatedAt))
  }, [documents, q, sort])
  const makeDocument = async () => {
    if (creating) return
    setCreating(true); setError('')
    try {
      const doc = await create({ title: nt('docs.untitled') })
      haptic('success')
      navigate(href({ section: 'docs', id: doc.id }))
    } catch (e) { haptic('error'); setError(e instanceof Error ? e.message : String(e)) }
    finally { setCreating(false) }
  }
  const deleteDocument = async (doc: ApiDocument) => {
    if (!window.confirm(nt('docs.deleteConfirm', { title: doc.title || nt('docs.untitled') }))) return
    try { await remove(doc.id) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return <section className="nx-docs">
    <header className="nx-docs__head"><div><h1>{nt('docs.title')}</h1><p>{nt('docs.subtitle')}</p></div>
      <button className="nx-btn nx-btn--primary" type="button" disabled={creating} onClick={() => void makeDocument()}>{creating ? <Spinner /> : <IPlus />}{nt('docs.new')}</button>
    </header>
    <div className="nx-docs__tools">
      <label className="nx-docs__search"><ISearch /><input value={q} placeholder={nt('docs.search')} aria-label={nt('docs.search')} onChange={(e) => navigate(href({ section: 'docs', params: { q: e.target.value || null, sort } }), { replace: true })} /></label>
      <label className="nx-docs__sort"><span>{nt('docs.sort')}</span><select value={sort} onChange={(e) => navigate(href({ section: 'docs', params: { q: q || null, sort: e.target.value } }), { replace: true })}><option value="updated">{nt('docs.sortUpdated')}</option><option value="title">{nt('docs.sortTitle')}</option></select></label>
    </div>
    {error && <div className="nx-docs__error" role="alert"><span>{error}</span><button type="button" className="nx-btn nx-btn--sm" onClick={() => { setError(''); void load().catch((e) => setError(String(e))) }}>{nt('docs.retry')}</button></div>}
    <div className="nx-docs__list nx-scroll" aria-busy={!loaded}>
      {!loaded ? <div className="nx-docs__loading"><Spinner large label={nt('docs.loading')} /></div> : rows.length === 0 ? <div className="nx-docs__empty"><IDoc /><b>{q ? nt('docs.noMatches') : nt('docs.empty')}</b>{!q && <button type="button" className="nx-btn nx-btn--outline" onClick={() => void makeDocument()}>{nt('docs.createFirst')}</button>}</div> : rows.map((doc) => <article className="nx-docs__row" key={doc.id}>
        <a href={href({ section: 'docs', id: doc.id })} onClick={linkClick} className="nx-docs__open"><span className="nx-docs__icon"><IDoc /></span><span className="nx-docs__meta"><b>{doc.title || nt('docs.untitled')}</b><small>{nt('docs.edited')} {listStamp(doc.updatedAt, locale)}</small></span></a>
        <IconButton label={nt('docs.delete')} className="nx-docs__delete" onClick={() => void deleteDocument(doc)}><ITrash /></IconButton>
      </article>)}
    </div>
  </section>
}

function DocumentScreen({ id, stack }: { id: string; stack: boolean }) {
  const nt = useNT()
  const swipe = useSwipeBackProps(() => goBack(href({ section: 'docs' })))
  return <motion.section className="nx-docs__editor" initial={stack ? { x: window.innerWidth } : false} animate={{ x: 0 }} exit={stack ? { x: window.innerWidth } : undefined} {...(stack ? swipe.props : {})}>
    <header className="nx-docs__editor-head"><button type="button" className="nx-btn" onClick={() => goBack(href({ section: 'docs' }))}>‹ {nt('docs.back')}</button><span>{nt('docs.editor')}</span></header>
    <div className="nx-docs__editor-body"><DocumentEditor documentId={id} /></div>
  </motion.section>
}

export default function DocsSection({ route, stack }: SectionProps) {
  return <div className="nx-docs-shell"><div className="nx-docs-shell__list" {...(stack && route.id ? { inert: '' as never } : {})}><DocsList route={route} /></div>
    {route.id && (stack ? <AnimatePresence><DocumentScreen key={route.id} id={route.id} stack /></AnimatePresence> : <DocumentScreen id={route.id} stack={false} />)}
  </div>
}
