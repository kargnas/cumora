/**
 * Routines = recurring agent tasks (calendar `agent_task` events) that post
 * into this room. Pausing one here is the same as pausing it in Calendar.
 */
import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { CalendarEvent, Conversation } from '@/types'
import { haptic } from '../haptics'
import { useNT, type NT } from '../i18n'
import { href, linkClick } from '../router'
import { Avatar } from '../ui/Avatar'
import { Spinner, Switch } from '../ui/primitives'
import { IRepeat } from '../ui/icons'

function cadence(e: CalendarEvent, nt: NT, locale: string): string {
  const time = new Date(e.startAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const r = e.recurrence
  if (!r) return nt('routines.once', { when: new Date(e.startAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
  const every = r.interval > 1 ? nt(`routines.every.${r.freq}`, { n: r.interval }) : nt(`routines.each.${r.freq}`)
  return `${every} · ${time}`
}

function RoutineRow({ e }: { e: CalendarEvent }) {
  const nt = useNT()
  const locale = useLocale()
  const assignee = useParticipants((s) => (e.assigneeId ? s.byId[e.assigneeId] : undefined))
  const update = useCalendar((s) => s.update)
  const runNow = useCalendar((s) => s.runNow)
  const [busy, setBusy] = useState<'toggle' | 'run' | null>(null)
  const [ran, setRan] = useState(false)
  const active = e.status === 'active'
  return (
    <div className="nx-routine" data-paused={!active || undefined}>
      <div className="nx-routine__top">
        {assignee ? <Avatar p={assignee} size={24} presence /> : <span className="nx-room-glyph"><IRepeat /></span>}
        <span className="nx-routine__text">
          <b>{e.title}</b>
          <span>{cadence(e, nt, locale)}</span>
        </span>
        {busy === 'toggle' && <Spinner />}
        <Switch
          label={nt('routines.active', { title: e.title })}
          checked={active}
          disabled={busy !== null || e.status === 'done' || e.status === 'cancelled'}
          onChange={async (v) => {
            setBusy('toggle')
            try { await update(e.id, { status: v ? 'active' : 'paused' }) } finally { setBusy(null) }
          }}
        />
      </div>
      {e.agentPrompt && <p className="nx-routine__prompt">{e.agentPrompt}</p>}
      <div className="nx-routine__actions">
        <button
          type="button"
          className="nx-btn nx-btn--sm nx-btn--outline"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('run')
            // Rethrown: the haptic marks the failure, it does not swallow it.
            try { await runNow(e.id); haptic('success'); setRan(true); window.setTimeout(() => setRan(false), 2500) } catch (err) { haptic('error'); throw err } finally { setBusy(null) }
          }}
        >
          {busy === 'run' ? <Spinner /> : null}
          {ran ? nt('routines.started') : nt('routines.runNow')}
        </button>
      </div>
    </div>
  )
}

export function RoutinesTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const loaded = useCalendar((s) => s.loaded)
  const loading = useCalendar((s) => s.loading)
  const events = useCalendar((s) => s.events)
  useEffect(() => { if (!loaded && !loading) void useCalendar.getState().load() }, [loaded, loading])
  const routines = useMemo(
    () => events.filter((e) => e.kind === 'agent_task' && e.targetConversationId === c.id && e.status !== 'cancelled'),
    [events, c.id],
  )
  if (!loaded) return <div className="nx-center" aria-busy="true"><Spinner /></div>
  return (
    <div className="nx-routines">
      {routines.length === 0 && <div className="nx-empty">{nt('routines.none')}</div>}
      {routines.map((e) => <RoutineRow key={e.id} e={e} />)}
      <a className="nx-btn nx-btn--outline nx-btn--block" href={href({ section: 'calendar' })} onClick={linkClick}>{nt('routines.open')}</a>
    </div>
  )
}
