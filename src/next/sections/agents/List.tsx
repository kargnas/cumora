/**
 * The roster: active agents (with live status, engine and computer), human
 * teammates, and off-boarded agents behind the Former filter. The filter is a
 * query param, so a filtered list survives reloads and Back.
 */
import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useMe } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { useParticipants } from '@/stores/participants'
import { engineLabel } from '@/lib/engines'
import type { Participant } from '@/types'
import { useNT } from '../../i18n'
import { href, linkClick, navigate, type Route } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { IconButton, Segmented, Spinner, T_FAST, type SegItem } from '../../ui/primitives'
import { IPlus } from '../../ui/icons'
import { agentState, dialogHref, engineOf, isBusy, LoadError, parseFilter, StateText, type Filter, type Roster } from './shared'

const byName = (a: Participant, b: Participant) => a.name.localeCompare(b.name)

const AgentRow = memo(function AgentRow({ p, to, active }: { p: Participant; to: string; active: boolean }) {
  const nt = useNT()
  const host = useComputers((s) => (p.computerId ? s.byId[p.computerId] : undefined))
  const isAgent = p.kind === 'agent'
  const engine = isAgent ? engineOf(p, host) : null
  // Cloud agents run the managed engine, so the computer name says it all.
  const where = isAgent
    ? [engine && engine.id !== 'managed' ? engineLabel(engine.id) : null, p.model, host?.name ?? (p.computerId ? null : nt('agents.cloud'))]
      .filter(Boolean).join(' · ')
    : ''
  return (
    <a
      href={to}
      onClick={(e) => linkClick(e, { replace: active })}
      className="nx-agents-row"
      aria-current={active ? 'page' : undefined}
      data-departed={p.departedAt ? '' : undefined}
    >
      {active && <motion.span layoutId="nx-agents-sel" className="nx-agents-row__sel" transition={T_FAST} />}
      <Avatar p={p} size={36} presence={!p.departedAt} />
      <span className="nx-agents-row__main">
        <span className="nx-agents-row__top">
          <span className="nx-agents-row__name">{p.name}</span>
          {p.role && <span className="nx-agents-row__role">{p.role}</span>}
        </span>
        <span className="nx-agents-row__meta">
          {isAgent ? <StateText p={p} state={agentState(p, host)} /> : <span>{nt('agents.teammate')}</span>}
          {where && <span className="nx-agents-row__where">{where}</span>}
        </span>
      </span>
    </a>
  )
})

function Skeleton() {
  return (
    <div aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="nx-agents-row nx-agents-row--skel">
          <span className="nx-skel" style={{ width: 36, height: 36, borderRadius: 999 }} />
          <span className="nx-agents-row__main">
            <span className="nx-skel" style={{ width: '45%', height: 12 }} />
            <span className="nx-skel" style={{ width: '80%', height: 10 }} />
          </span>
        </div>
      ))}
    </div>
  )
}

interface Group { key: string; label: string | null; items: Participant[] }

export function AgentList({ route, roster, refreshing }: { route: Route; roster: Roster; refreshing: boolean }) {
  const nt = useNT()
  const me = useMe()
  const filter = parseFilter(route.search.get('filter'))
  const people = useParticipants(useShallow((s) => Object.values(s.byId).sort(byName)))
  const hosts = useComputers((s) => s.byId)

  const { agents, busy, former, humans } = useMemo(() => {
    const out = { agents: [] as Participant[], busy: new Set<string>(), former: [] as Participant[], humans: [] as Participant[] }
    for (const p of people) {
      if (p.kind === 'human') {
        if (p.id !== me) out.humans.push(p)
      } else if (p.departedAt) {
        out.former.push(p)
      } else {
        out.agents.push(p)
        if (isBusy(agentState(p, p.computerId ? hosts[p.computerId] : undefined))) out.busy.add(p.id)
      }
    }
    // Most recently off-boarded first, as the classic roster ordered them.
    out.former.sort((a, b) => (b.departedAt ?? '').localeCompare(a.departedAt ?? ''))
    return out
  }, [people, hosts, me])

  const groups: Group[] = filter === 'working' ? [{ key: 'working', label: null, items: agents.filter((p) => busy.has(p.id)) }]
    : filter === 'idle' ? [{ key: 'idle', label: null, items: agents.filter((p) => !busy.has(p.id)) }]
      : filter === 'departed' ? [{ key: 'former', label: null, items: former }]
        : [
            { key: 'agents', label: nt('agents.groupAgents'), items: agents },
            { key: 'people', label: nt('agents.groupPeople'), items: humans },
          ]

  const count = (n: number) => <span className="nx-agents-count nx-mono">{n}</span>
  const tabs: Array<SegItem<Filter>> = [
    { key: 'all', label: nt('agents.filter.all') },
    { key: 'working', label: nt('agents.filter.working'), badge: count(busy.size) },
    { key: 'idle', label: nt('agents.filter.idle'), badge: count(agents.length - busy.size) },
    // Former only exists once someone has been off-boarded.
    ...(former.length > 0 || filter === 'departed'
      ? [{ key: 'departed' as const, label: nt('agents.filter.departed'), badge: count(former.length) }]
      : []),
  ]
  // Moving to another agent keeps the open view and the handbook's range;
  // a scrubbed time belongs to one agent's changes, so it stays behind.
  const toAgent = (id: string) => href({
    section: 'agents',
    id,
    params: { filter: filter === 'all' ? null : filter, view: route.search.get('view'), since: route.search.get('since') },
  })

  const empty = filter === 'working' ? nt('agents.noneWorking') : filter === 'idle' ? nt('agents.noneIdle') : null

  return (
    <aside className="nx-agents-list" aria-label={nt('agents.title')}>
      <header className="nx-agents-head">
        <h1>{nt('agents.title')}</h1>
        {refreshing && <Spinner label={nt('agents.refreshing')} />}
        <IconButton
          label={nt('agents.hire')}
          tipPlace="below"
          ring
          onClick={() => navigate(dialogHref(route, 'new'))}
        >
          <IPlus />
        </IconButton>
      </header>
      <div className="nx-agents-filters">
        <Segmented
          label={nt('agents.filters')}
          value={filter}
          items={tabs}
          onChange={(k) => navigate(href({ section: 'agents', id: route.id, params: { filter: k === 'all' ? null : k } }), { replace: true })}
        />
      </div>
      <div className="nx-agents-scroll nx-scroll" aria-busy={roster.state === 'loading' || undefined}>
        {roster.state === 'loading' ? <Skeleton />
          : roster.state === 'error' ? <LoadError onRetry={roster.retry} />
            : (
              <>
                {filter === 'departed' && <p className="nx-agents-note">{nt('agents.formerBody')}</p>}
                {filter === 'all' && agents.length === 0 && (
                  <div className="nx-empty">
                    <b>{nt('agents.emptyTitle')}</b>
                    {nt('agents.emptyBody')}
                    <a className="nx-btn nx-btn--outline nx-btn--sm" href={dialogHref(route, 'new')} onClick={linkClick}>
                      <IPlus />
                      {nt('agents.hire')}
                    </a>
                  </div>
                )}
                {empty && groups[0].items.length === 0 && <div className="nx-empty">{empty}</div>}
                {groups.filter((g) => g.items.length > 0).map((g) => (
                  <section key={g.key} aria-label={g.label ?? undefined}>
                    {g.label && <h2 className="nx-group-label">{g.label}</h2>}
                    {g.items.map((p) => <AgentRow key={p.id} p={p} to={toAgent(p.id)} active={p.id === route.id} />)}
                  </section>
                ))}
              </>
            )}
      </div>
    </aside>
  )
}
