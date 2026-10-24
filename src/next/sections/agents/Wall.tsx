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
import { noWorkReason } from './hasWork'
import {
  agentsFor, agentState, dialogHref, EMPTY_FILTER, FilterTabs, LoadError, parseFilter, RosterSwitch, StateText, useHost, useSeesWork, useTeam, type Roster,
} from './shared'

/** The thread the agent is on (the newest still going), else its newest one with
 *  its status; the menu's Now line names only a running one. Each tile reads
 *  its own agent's threads, so one `fork.coding` event costs a read per working
 *  tile; past a few dozen agents, a store keyed by agent id should share them.
 *  Like the thumbnail, it rests while an agent's page covers the wall. */
function NowLine({ p, covered }: { p: Participant; covered: boolean }) {
  const nt = useNT()
  const { coding } = useCoding(p.id, !covered)
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

// An empty box says why; a host that has not loaded yet leaves it blank.
const WHY = { departed: 'agents.filter.departed', cloud: 'agents.cloud', locked: 'coding.locked' } as const

const Tile = memo(function Tile({ p, to, covered }: { p: Participant; to: string; covered: boolean }) {
  const nt = useNT()
  const host = useHost(p)
  const hold = useHold((x, y) => openAgentMenu(p.id, { x, y }))
  const working = useSeesWork(p)
  const admin = useAdmin()
  const why = noWorkReason(p, host, admin)
  return (
    <a href={to} onClick={linkClick} className="nx-agents-tile" data-departed={p.departedAt ? '' : undefined} {...hold}>
      {/* Every tile keeps the screen's box, so a row of tiles stays one height. */}
      {working ? <ScreenThumb agent={p} paused={covered} /> : (
        <span className="nx-thumb">{why && nt(WHY[why])}</span>
      )}
      <span className="nx-agents-tile__who">
        <Avatar p={p} size={24} presence={!p.departedAt} className={p.departedAt ? 'nx-agents-gone' : undefined} />
        <span className="nx-agents-tile__name">{p.name}</span>
        <StateText p={p} state={agentState(p, host)} />
      </span>
      {working ? <NowLine p={p} covered={covered} /> : <span className="nx-agents-tile__line">{p.role ?? nt('agents.noRole')}</span>}
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

/** `covered`: an agent's page is pushed over the wall (a phone), so its thumbnails rest. */
export function AgentWall({ route, roster, refreshing, covered }: { route: Route; roster: Roster; refreshing: boolean; covered: boolean }) {
  const nt = useNT()
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
                    {shown.map((p) => <Tile key={p.id} p={p} to={toAgent(p.id)} covered={covered} />)}
                  </div>
                )}
              </>
            )}
      </div>
    </section>
  )
}
