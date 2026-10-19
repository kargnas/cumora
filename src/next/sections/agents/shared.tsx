/** Helpers and small pieces shared by the agents list, profile and dialogs. */
import { useCallback, useEffect, useState } from 'react'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Computer, EngineId, Participant, Status } from '@/types'
import { useNT } from '../../i18n'
import { href, withRoute, type Route } from '../../router'
import { elapsed } from '../../format'
import { useNow } from '../../hooks'

/** Status as the team sees it. The server's status, unless the agent was
 *  off-boarded or its own computer is offline: then nothing it last reported
 *  is current (the same rule as `usePresence` in ui/Avatar). */
type AgentState = Status | 'offline' | 'departed'

export function agentState(p: Participant, host: Computer | undefined): AgentState {
  if (p.departedAt) return 'departed'
  if (host && host.kind !== 'cloud' && host.status !== 'online') return 'offline'
  return p.status
}

/** Working or thinking: the breathing ring and the shimmer. */
const isLive = (s: AgentState): boolean => s === 'working' || s === 'thinking'

/** Busy for the filter and the timer: live, or blocked on a person. */
export const isBusy = (s: AgentState): boolean => isLive(s) || s === 'waiting'

export type Filter = 'all' | 'working' | 'idle' | 'departed'
const FILTERS: Filter[] = ['all', 'working', 'idle', 'departed']

export function parseFilter(raw: string | null): Filter {
  return FILTERS.includes(raw as Filter) ? raw as Filter : 'all'
}

/** The list URL, keeping the filter the user picked. */
export function listHref(route: Route): string {
  return href({ section: 'agents', params: { filter: route.search.get('filter') } })
}

/** Query params of the dialogs this section opens. */
export const DIALOG_PARAMS = ['new', 'edit', 'offboard', 'purge'] as const
export const NO_DIALOG = { new: null, edit: null, offboard: null, purge: null }

/** The current screen with one dialog open (and no other). */
export function dialogHref(route: Route, dialog: typeof DIALOG_PARAMS[number]): string {
  return withRoute(route, { params: { ...NO_DIALOG, [dialog]: '1' } })
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Engine an agent runs on, by AgentEditor's rules: Cumora Cloud is the managed
 * engine; a computer's agent follows that computer's first engine unless it
 * pinned another (a provider profile pins Claude Code). `null` while the
 * agent's computer is not loaded, so the UI never guesses "cloud".
 */
export function engineOf(p: Participant, host: Computer | undefined): { id: EngineId; inherited: boolean } | null {
  if (!host) return p.computerId ? null : { id: 'managed', inherited: false }
  if (host.kind === 'cloud') return { id: 'managed', inherited: false }
  const advertised = host.availableEngines
  const pinned: EngineId | null = p.providerProfile ? 'claude' : p.engine && p.engine !== 'managed' ? p.engine : null
  // Official production omits `engineInherit`; there an engine equal to the
  // computer default counts as following it, as in the editor.
  const inherited = !pinned || p.engineInherit === true
    || (p.engineInherit === undefined && !p.providerProfile && pinned === advertised[0])
  const id = inherited ? advertised[0] ?? pinned : pinned
  return id ? { id, inherited } : null
}

/** The model an unpinned agent gets: its provider profile's, else the
 *  computer's per-engine default, else what the engine's CLI reports. */
export function defaultModelOf(p: Participant, host: Computer | undefined, engine: EngineId): string | null {
  if (!host) return null
  const detected = host.detectedEngines?.find((e) => e.id === engine)
  if (p.providerProfile) return detected?.providerProfiles?.find((x) => x.id === p.providerProfile)?.model ?? null
  return host.engineDefaults?.[engine]?.model ?? detected?.modelCatalog?.defaultModel ?? null
}

export function providerLabel(p: Participant, host: Computer | undefined): string | null {
  if (!p.providerProfile) return null
  const profiles = host?.detectedEngines?.find((e) => e.id === 'claude')?.providerProfiles
  return profiles?.find((x) => x.id === p.providerProfile)?.label ?? p.providerProfile
}

export interface Roster {
  state: 'loading' | 'error' | 'ready'
  retry: () => void
}

/** First load of the roster. The participants store logs fetch errors instead
 *  of keeping them, so a failure shows as "still not loaded after a fetch". */
export function useRoster(): Roster {
  const loaded = useParticipants((s) => s.loaded)
  const [failed, setFailed] = useState(false)
  const retry = useCallback(() => {
    setFailed(false)
    void useParticipants.getState().refresh().then(() => setFailed(!useParticipants.getState().loaded))
  }, [])
  useEffect(() => {
    if (!useParticipants.getState().loaded) retry()
  }, [retry])
  return { state: loaded ? 'ready' : failed ? 'error' : 'loading', retry }
}

export function LoadError({ onRetry }: { onRetry: () => void }) {
  const nt = useNT()
  return (
    <div className="nx-empty" role="alert">
      <b>{nt('agents.loadFailed')}</b>
      <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={onRetry}>{nt('agents.retry')}</button>
    </div>
  )
}

/** "Working 2:31": the state, with a 1 Hz timer from `statusUpdatedAt` while
 *  the agent is busy. Only busy agents subscribe to the shared clock. */
export function StateText({ p, state }: { p: Participant; state: AgentState }) {
  const nt = useNT()
  const locale = useLocale()
  const ticking = isBusy(state)
  // The shared clock drives the 1 Hz re-render; the time itself is read here
  // because the clock's last tick can be stale until its first new one.
  useNow(ticking)
  const now = Date.now()
  const since = p.statusUpdatedAt ? Date.parse(p.statusUpdatedAt) : Number.NaN
  const label = state === 'departed' && p.departedAt
    ? nt('agents.departedOn', { date: new Date(p.departedAt).toLocaleDateString(locale, { dateStyle: 'medium' }) })
    : nt(`agents.state.${state}`)
  return (
    <span className="nx-agents-state" data-s={state}>
      <span className={isLive(state) ? 'nx-shimmer' : undefined}>{label}</span>
      {ticking && Number.isFinite(since) && <span className="nx-mono">{elapsed(now - since)}</span>}
    </span>
  )
}
