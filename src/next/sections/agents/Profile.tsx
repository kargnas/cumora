/**
 * One participant's profile. Agents get status, placement (computer, engine,
 * model), tools, email, autonomy and the hire/off-board/delete actions; people get
 * the parts that apply to them (message, email). An agent's page opens on its
 * workspace (Work.tsx) for owners and admins; `?view=profile` shows this
 * profile and `?view=handbook` its Handbook, its standing files with what
 * changed. The agent drawer in chats shows this profile too.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { usePrefs } from '@/stores/preferences'
import { engineLabel } from '@/lib/engines'
import type { Computer, Participant } from '@/types'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { getRoute, linkClick, navigate, withRoute, type Route } from '../../router'
import { useOpenDirect } from '../../hooks'
import { Avatar } from '../../ui/Avatar'
import { Segmented, Spinner } from '../../ui/primitives'
import { ICheck, ICompose, ICopy, IExit, IPencil, IRepeat, ITrash } from '../../ui/icons'
import { Handbook } from '../../panel/HandbookTab'
import { AgentWork } from './Work'
import {
  agentState, defaultModelOf, dialogHref, engineOf, errorText, listHref, LoadError, providerLabel, StateText, useHost, useHostPending, useSeesWork,
  type Roster,
} from './shared'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="nx-agents-block">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nx-row">
      <span className="nx-row__text">{label}</span>
      <span className="nx-agents-value">{children}</span>
    </div>
  )
}

function Actions({ p, route, onRefresh }: { p: Participant; route: Route; onRefresh: () => Promise<void> }) {
  const nt = useNT()
  const me = useMe()
  const openDirect = useOpenDirect()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => Promise<unknown>, failKey: 'agents.messageFailed' | 'agents.rehireFailed') => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      haptic('error')
      setError(nt(failKey, { error: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }

  if (p.departedAt) {
    return (
      <div className="nx-agents-actions">
        <button
          type="button"
          className="nx-btn nx-btn--primary"
          disabled={busy}
          // Success only here: Message's success is opening the DM, which is navigation.
          onClick={run(async () => { await api.rehireAgent(p.id); await onRefresh(); haptic('success') }, 'agents.rehireFailed')}
        >
          {busy ? <Spinner /> : <IRepeat />}
          {nt('agents.rehire')}
        </button>
        {error && <p className="nx-agents-error" role="alert">{error}</p>}
      </div>
    )
  }
  if (p.id === me) return null
  return (
    <div className="nx-agents-actions">
      <button type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={run(() => openDirect(p.id), 'agents.messageFailed')}>
        {busy ? <Spinner /> : <ICompose />}
        {nt('agents.message')}
      </button>
      {p.kind === 'agent' && (
        <a className="nx-btn nx-btn--outline" href={dialogHref(route, 'edit')} onClick={linkClick}>
          <IPencil />
          {nt('agents.edit')}
        </a>
      )}
      {error && <p className="nx-agents-error" role="alert">{error}</p>}
    </div>
  )
}

function RunsOn({ p, host }: { p: Participant; host: Computer | undefined }) {
  const nt = useNT()
  const engine = engineOf(p, host)
  const provider = providerLabel(p, host)
  const fallback = engine ? defaultModelOf(p, host, engine.id) : null
  const local = host && host.kind !== 'cloud'
  return (
    <Block title={nt('agents.runsOn')}>
      <div className="nx-rows">
        <Row label={nt('agents.computer')}>
          {host?.name ?? (p.computerId ? nt('agents.unknown') : nt('agents.cloud'))}
          {local && <small data-s={host.status}>{nt(`agents.computer.${host.status}`)}</small>}
        </Row>
        <Row label={nt('agents.engine')}>
          {engine ? engineLabel(engine.id) : nt('agents.unknown')}
          {engine?.inherited && <small>{nt('agents.followsComputer')}</small>}
        </Row>
        {provider && <Row label={nt('agents.provider')}>{provider}</Row>}
        <Row label={nt('agents.model')}>
          {p.model
            ? <span className="nx-mono">{p.model}</span>
            : fallback ? nt('agents.modelDefaultIs', { model: fallback }) : nt('agents.modelDefault')}
        </Row>
        {p.fastModel && <Row label={nt('agents.fastModel')}><span className="nx-mono">{p.fastModel}</span></Row>}
      </div>
      {local && host.status === 'offline' && (
        <p className="nx-agents-note">{nt('agents.offlineHint', { computer: host.name, name: p.name })}</p>
      )}
    </Block>
  )
}

function Email({ email }: { email: string }) {
  const nt = useNT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <Block title={nt('agents.email')}>
      <div className="nx-rows">
        <div className="nx-row">
          <span className="nx-row__text nx-mono nx-agents-email">{email}</span>
          <button
            type="button"
            className="nx-btn nx-btn--sm"
            onClick={() => navigator.clipboard.writeText(email).then(
              () => setCopied(true),
              (e) => { haptic('error'); console.warn('[next] copy failed', e) },
            )}
          >
            {copied ? <ICheck /> : <ICopy />}
            {copied ? nt('agents.copied') : nt('agents.copy')}
          </button>
        </div>
      </div>
    </Block>
  )
}

/** The viewer's own trust setting for this agent (stored per person). */
function Autonomy({ p }: { p: Participant }) {
  const nt = useNT()
  const record = usePrefs((s) => s.autonomy[p.id])
  const saved = record?.threshold ?? 0.6
  const [draft, setDraft] = useState(saved)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(saved), [saved])
  // React's onChange fires on every step of a drag; the native `change` event
  // fires once when the thumb is released (or per arrow key), which is when
  // the value is worth a PUT.
  useEffect(() => {
    const el = input.current
    if (!el) return
    const commit = () => void usePrefs.getState().setAutonomy(p.id, Number(el.value))
    el.addEventListener('change', commit)
    return () => el.removeEventListener('change', commit)
  }, [p.id])
  return (
    <Block title={nt('agents.autonomy')}>
      <div className="nx-rows">
        <label className="nx-agents-autonomy">
          <span className="nx-agents-autonomy__top">
            <span>{nt('agents.autonomyLabel')}</span>
            <span className="nx-mono">{draft.toFixed(2)}</span>
          </span>
          <input
            ref={input}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={draft}
            onChange={(e) => setDraft(Number(e.target.value))}
            aria-label={nt('agents.autonomyLabel')}
            className="nx-agents-range"
          />
          <span className="nx-row__hint">{nt('agents.autonomyHint', { name: p.name })}</span>
        </label>
        <div className="nx-row">
          <span className="nx-row__hint nx-mono">
            {nt('agents.track', { pulled: record?.pulled ?? 0, led: record?.led ?? 0, noise: record?.dissolved ?? 0 })}
          </span>
        </div>
      </div>
    </Block>
  )
}

export function Profile({ p, route, onRefresh }: { p: Participant; route: Route; onRefresh: () => Promise<void> }) {
  const nt = useNT()
  const host = useHost(p)
  const isAgent = p.kind === 'agent'
  const departed = Boolean(p.departedAt)
  // The classic card fell back to the agent's style prompt when it had no bio.
  const about = p.bio || (isAgent ? p.systemPrompt : undefined)
  return (
    <article className="nx-agents-profile" aria-label={p.name}>
      <header className="nx-agents-hero">
        <Avatar p={p} size={80} presence={!departed} className={departed ? 'nx-agents-gone' : undefined} />
        <h2>{p.name}</h2>
        {(p.role || !isAgent) && <span className="nx-agents-hero__role">{p.role ?? nt('agents.teammate')}</span>}
        {isAgent && <StateText p={p} state={agentState(p, host)} />}
      </header>
      <Actions p={p} route={route} onRefresh={onRefresh} />
      {about && (
        <Block title={nt('agents.about')}>
          <p className="nx-agents-about">{about}</p>
        </Block>
      )}
      {isAgent && <RunsOn p={p} host={host} />}
      {isAgent && p.tools && p.tools.length > 0 && (
        <Block title={nt('agents.tools')}>
          <div className="nx-agents-tools">
            {p.tools.map((t) => <span key={t} className="nx-chip nx-mono">{t}</span>)}
          </div>
        </Block>
      )}
      {p.email && <Email email={p.email} />}
      {isAgent && !departed && <Autonomy p={p} />}
      {isAgent && !departed && (
        <a className="nx-btn nx-btn--danger nx-btn--block" href={dialogHref(route, 'offboard')} onClick={linkClick}>
          <IExit />
          {nt('agents.offboard', { name: p.name })}
        </a>
      )}
      {isAgent && departed && (
        <a className="nx-btn nx-btn--danger nx-btn--block" href={dialogHref(route, 'purge')} onClick={linkClick}>
          <ITrash />
          {nt('agents.purge', { name: p.name })}
        </a>
      )}
    </article>
  )
}

type View = 'work' | 'profile' | 'handbook'
const VIEW_LABEL = { work: 'agents.viewWork', profile: 'agents.viewProfile', handbook: 'agents.viewHandbook' } as const

function ProfileSkeleton() {
  return (
    <div className="nx-agents-profile" aria-busy="true">
      <div className="nx-agents-hero">
        <span className="nx-skel" style={{ width: 80, height: 80, borderRadius: 999 }} />
        <span className="nx-skel" style={{ width: 120, height: 20, marginTop: 8 }} />
        <span className="nx-skel" style={{ width: 88, height: 12 }} />
      </div>
      <span className="nx-skel" style={{ height: 132 }} />
    </div>
  )
}

export function AgentProfile({ id, route, roster, onRefresh }: {
  id: string
  route: Route
  roster: Roster
  onRefresh: () => Promise<void>
}) {
  const nt = useNT()
  const p = useParticipants((s) => s.byId[id])
  const seesWork = useSeesWork(p)
  const hostPending = useHostPending(p)
  if (roster.state === 'loading') return <ProfileSkeleton />
  if (roster.state === 'error') return <LoadError onRetry={roster.retry} />
  if (!p) {
    return (
      <div className="nx-empty nx-agents-fill">
        <b>{nt('agents.notFound')}</b>
        <a className="nx-btn nx-btn--outline nx-btn--sm" href={listHref(route)} onClick={(e) => linkClick(e, { replace: true })}>
          {nt('agents.allAgents')}
        </a>
      </div>
    )
  }
  if (p.kind !== 'agent') return <Profile p={p} route={route} onRefresh={onRefresh} />
  // An admin's views depend on the agent's host, so they wait for it.
  if (hostPending) return <ProfileSkeleton />
  // The workspace's screen and threads answer only owners and admins, and
  // only an agent on a computer has them; the first view needs no `?view=`.
  const views: View[] = seesWork ? ['work', 'profile', 'handbook'] : ['profile', 'handbook']
  const asked = route.search.get('view') as View | null
  const view = asked && views.includes(asked) ? asked : views[0]
  return (
    <>
      <div className="nx-agents-views">
        <Segmented
          label={nt('agents.views')}
          value={view}
          // A picked view stays in the URL: the first view can still change
          // (an admin's Work, once computers that failed to load come back),
          // and that must not move the user.
          onChange={(v) => navigate(withRoute(getRoute(), { params: { view: v } }), { replace: true })}
          items={views.map((k) => ({ key: k, label: nt(VIEW_LABEL[k]) }))}
        />
      </div>
      {view === 'work' ? <AgentWork p={p} />
        : view === 'handbook' ? <div className="nx-agents-handbook"><Handbook agentId={p.id} /></div>
          : <Profile p={p} route={route} onRefresh={onRefresh} />}
    </>
  )
}
