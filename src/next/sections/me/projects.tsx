/** Projects: named, tinted bundles of related rooms. */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { api, type ApiProject } from '@/api/client'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import type { Route } from '../../router'
import { Dialog, Spinner } from '../../ui/primitives'
import { IPlus } from '../../ui/icons'
import { closeSheet, count, ErrorLine, errorText, LongList, openSheet, setParams, SkeletonRows } from './parts'

const ProjectRow = memo(function ProjectRow({ p, sep, onArchive }: { p: ApiProject; sep: boolean; onArchive: (p: ApiProject) => void }) {
  const nt = useNT()
  const archived = p.status === 'archived'
  return (
    <div className="nx-me-row" data-sep={sep || undefined} data-dim={archived || undefined}>
      <span className="nx-me-swatch" style={p.color ? { background: p.color } : undefined} aria-hidden />
      <span className="nx-me-row__text">
        <span className="nx-me-row__label nx-me-row__line">
          <span className="nx-me-row__name">{p.name}</span>
          {archived && <span className="nx-chip">{nt('me.projects.archived')}</span>}
        </span>
        <span className="nx-me-row__hint">
          {p.description || nt('me.projects.noDescription')}
          {' · '}
          {count(nt, p.conversationCount, 'me.projects.roomOne', 'me.projects.rooms')}
        </span>
      </span>
      {/* Archiving is optimistic (the row moves at once), so a tap, not success. */}
      <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={() => { haptic('tap'); onArchive(p) }}>
        {nt(archived ? 'me.projects.restore' : 'me.projects.archive')}
      </button>
    </div>
  )
})

function NewProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const nt = useNT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await api.createProject({ name: trimmed, description: description.trim() })
      await onCreated()
      haptic('success')
      closeSheet('new-project')
    } catch (e) {
      haptic('error')
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <form className="nx-me-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.projects.name')}</span>
        <input className="nx-input" value={name} disabled={busy} placeholder={nt('me.projects.namePh')} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.projects.description')}</span>
        <input className="nx-input" value={description} disabled={busy} placeholder={nt('me.projects.descriptionPh')} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <ErrorLine message={error} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" onClick={() => closeSheet('new-project')}>{nt('me.cancel')}</button>
        <button type="submit" className="nx-btn nx-btn--primary" disabled={busy || !name.trim()}>
          {busy && <Spinner />}
          {nt('me.projects.create')}
        </button>
      </div>
    </form>
  )
}

export function ProjectsPage({ route }: { route: Route }) {
  const nt = useNT()
  const [projects, setProjects] = useState<ApiProject[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const showArchived = route.search.get('archived') === '1'

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setProjects(await api.listProjects())
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  // Optimistic: the row moves at once and moves back if the server refuses.
  const archive = useCallback(async (p: ApiProject) => {
    const next = p.status === 'archived' ? 'active' : 'archived'
    const put = (status: ApiProject['status']) => setProjects((cur) => cur && cur.map((x) => (x.id === p.id ? { ...x, status } : x)))
    setActionError(null)
    put(next)
    try {
      await api.archiveProject(p.id, next === 'archived')
    } catch (e) {
      put(p.status)
      setActionError(errorText(e))
    }
  }, [])

  const visible = useMemo(() => (projects ?? []).filter((p) => showArchived || p.status === 'active'), [projects, showArchived])
  const archivedCount = useMemo(() => (projects ?? []).filter((p) => p.status === 'archived').length, [projects])

  return (
    <>
      <p className="nx-me-intro">{nt('me.projects.intro')}</p>
      <div className="nx-me-actions nx-me-actions--start">
        <button type="button" className="nx-btn nx-btn--primary" onClick={() => openSheet(route, 'new-project')}>
          <IPlus />
          {nt('me.projects.new')}
        </button>
        {(archivedCount > 0 || showArchived) && (
          <button
            type="button"
            className="nx-btn nx-btn--outline"
            aria-pressed={showArchived}
            onClick={() => { haptic('select'); setParams(route, { archived: showArchived ? null : '1' }) }}
          >
            {nt(showArchived ? 'me.projects.hideArchived' : 'me.projects.showArchived', { n: archivedCount })}
          </button>
        )}
      </div>
      {loadError && <ErrorLine message={loadError} onRetry={() => void load()} />}
      {actionError && <ErrorLine message={actionError} />}
      {projects === null ? (
        !loadError && <SkeletonRows n={3} />
      ) : visible.length === 0 ? (
        <div className="nx-me-card"><p className="nx-me-empty">{nt('me.projects.empty')}</p></div>
      ) : (
        <div className="nx-me-card">
          <LongList items={visible} itemKey={(p) => p.id}>
            {(p, i) => <ProjectRow p={p} sep={i > 0} onArchive={archive} />}
          </LongList>
        </div>
      )}
      <Dialog open={route.search.get('sheet') === 'new-project'} onClose={() => closeSheet('new-project')} title={nt('me.projects.new')}>
        <NewProjectForm onCreated={load} />
      </Dialog>
    </>
  )
}
