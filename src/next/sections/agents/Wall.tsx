/**
 * The Agents wall, the section's default: every agent as a tile with what it
 * is doing now, so a glance shows who works on what and who waits for you.
 * Owners and admins see a small copy of each agent's browser (ScreenThumb:
 * one frame every few seconds, only for tiles on screen) and its newest T3
 * Code thread; everyone sees its state and role. A click opens the agent's
 * workspace; a right-click or a long press opens the agent menu. Filters are
 * the list's (`?filter=`).
 */
import { memo } from 'react'
import { useComputers } from '@/stores/computers'
import type { Participant } from '@/types'
import { openAgentMenu } from '../../agentMenu'
import { useAdmin, useHold } from '../../hooks'
import { useNT } from '../../i18n'
import { href, linkClick, navigate, type Route } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { IconButton, Spinner } from '../../ui/primitives'
import { IPlus } from '../../ui/icons'
import { isOpenThread, lastPr, look, newestThreads, useCoding } from '../../panel/CodingTab'
import { ScreenThumb } from '../../panel/ComputerTab'
import {
  agentsFor, agentState, dialogHref, EMPTY_FILTER, FilterTabs, hasWork, LoadError, parseFilter, RosterSwitch, StateText, useTeam, type Roster,
} from './shared'

/** The thread the agent is on (the newest still going), else its newest one. */
function NowLine({ p }: { p: Participant }) {
  const nt = useNT()
  const { coding } = useCoding(p.id)
  if (!coding) return <span className="nx-agents-tile__line" aria-hidden />
  const threads = newestThreads(coding).map((x) => x.t)
  const t = threads.find(isOpenThread) ?? threads[0]
  if (!t) return <span className="nx-agents-tile__line">{nt('agents.noThreads')}</span>
  const { tone, icon } = look(t.status)
  const pr = lastPr(t)
  return (
    <span className="nx-agents-tile__line" data-tone={tone}>
      {icon}
      <span className="nx-agents-tile__title">{t.title}</span>
      {pr && <span className="nx-chip nx-mono">#{pr.number}</span>}
    </span>
  )
}

const Tile = memo(function Tile({ p, to, admin }: { p: Participant; to: string; admin: boolean }) {
  const nt = useNT()
  const host = useComputers((s) => (p.computerId ? s.byId[p.computerId] : undefined))
  const hold = useHold((x, y) => openAgentMenu(p.id, { x, y }))
  const working = admin && hasWork(p)
  return (
    <a href={to} onClick={linkClick} className="nx-agents-tile" data-departed={p.departedAt ? '' : undefined} {...hold}>
      {/* Every tile keeps the screen's box, so a row of tiles stays one height. */}
      {working ? <ScreenThumb agent={p} /> : (
        <span className="nx-thumb">
          {nt(p.departedAt ? 'agents.filter.departed' : !p.computerId ? 'agents.cloud' : 'coding.locked')}
        </span>
      )}
      <span className="nx-agents-tile__who">
        <Avatar p={p} size={24} presence={!p.departedAt} className={p.departedAt ? 'nx-agents-gone' : undefined} />
        <span className="nx-agents-tile__name">{p.name}</span>
        <StateText p={p} state={agentState(p, host)} />
      </span>
      {working ? <NowLine p={p} /> : <span className="nx-agents-tile__line">{p.role ?? nt('agents.noRole')}</span>}
    </a>
  )
})

function Skeleton() {
  return (
    <div className="nx-agents-wall__grid" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => <span key={i} className="nx-skel nx-agents-tile--skel" />)}
    </div>
  )
}

export function AgentWall({ route, roster, refreshing }: { route: Route; roster: Roster; refreshing: boolean }) {
  const nt = useNT()
  const admin = useAdmin()
  const filter = parseFilter(route.search.get('filter'))
  const team = useTeam()
  const shown = agentsFor(team, filter)
  const toAgent = (id: string) => href({ section: 'agents', id, params: { filter: filter === 'all' ? null : filter } })
  const empty = filter === 'working' || filter === 'idle' ? nt(EMPTY_FILTER[filter]) : null

  return (
    <section className="nx-agents-wall" aria-label={nt('agents.title')}>
      <header className="nx-agents-head">
        <h1>{nt('agents.title')}</h1>
        {refreshing && <Spinner label={nt('agents.refreshing')} />}
        <RosterSwitch route={route} />
        <IconButton label={nt('agents.hire')} tipPlace="below" ring onClick={() => navigate(dialogHref(route, 'new'))}>
          <IPlus />
        </IconButton>
      </header>
      <div className="nx-agents-filters"><FilterTabs route={route} team={team} /></div>
      <div className="nx-agents-wall__scroll nx-scroll" aria-busy={roster.state === 'loading' || undefined}>
        {roster.state === 'loading' ? <Skeleton />
          : roster.state === 'error' ? <LoadError onRetry={roster.retry} />
            : (
              <>
                {filter === 'departed' && <p className="nx-agents-note">{nt('agents.formerBody')}</p>}
                {filter === 'all' && team.agents.length === 0 && (
                  <div className="nx-empty">
                    <b>{nt('agents.emptyTitle')}</b>
                    {nt('agents.emptyBody')}
                    <a className="nx-btn nx-btn--outline nx-btn--sm" href={dialogHref(route, 'new')} onClick={linkClick}>
                      <IPlus />
                      {nt('agents.hire')}
                    </a>
                  </div>
                )}
                {empty && shown.length === 0 && <div className="nx-empty">{empty}</div>}
                {shown.length > 0 && (
                  <div className="nx-agents-wall__grid">
                    {shown.map((p) => <Tile key={p.id} p={p} to={toAgent(p.id)} admin={admin} />)}
                  </div>
                )}
              </>
            )}
      </div>
    </section>
  )
}
