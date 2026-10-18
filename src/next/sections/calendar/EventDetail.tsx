/**
 * One event: what it is, when it fires (in the viewer's timezone), who it
 * wakes and where, and its controls: pause/resume, run now, edit, delete,
 * and the dispatch history. The id comes from `?event=`; a short id (the
 * `ce-d53fa1f5` form agents paste) resolves like a git short SHA, and an
 * event the list does not hold yet is fetched on its own. A room's right
 * panel shows it too (an event peek), where Edit leaves for Calendar.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useCalendar } from '@/stores/calendar'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import { nextOccurrenceOnOrAfter } from '@/lib/recurrence'
import { useResolvedCalendarId } from '@/lib/useArtifactId'
import type { CalendarDispatch, CalendarEvent } from '@/types'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { getRoute, href, linkClick, navigate, useRoute, withRoute } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { IconButton, Spinner, Switch } from '../../ui/primitives'
import { IChat, ICheck, IChevronLeft, IHash, IMail, IPencil, IX } from '../../ui/icons'
import { dateLabel, describeReminder, describeRepeat, stampLabel, whenLabel, zoneName } from './model'
import { EDITOR_PARAMS, errText, KindMark, RunNow, runLabel } from './parts'
// Here as well as in the section: the room panel loads this view on its own.
import './calendar.css'

/** Dispatch rows shown; the server keeps up to 200 per event. */
const RUNS_SHOWN = 10

function DetailBar({ stack, onClose, children }: { stack: boolean; onClose: () => void; children?: ReactNode }) {
  const nt = useNT()
  return (
    <header className="nx-calendar-detail__bar">
      <IconButton label={stack ? nt('calendar.back') : nt('common.close')} onClick={onClose}>
        {stack ? <IChevronLeft /> : <IX />}
      </IconButton>
      <span className="nx-calendar-detail__grow" />
      {children}
    </header>
  )
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nx-row nx-calendar-kv">
      <span className="nx-calendar-kv__label">{label}</span>
      <span className="nx-calendar-kv__value">{children}</span>
    </div>
  )
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <section className="nx-calendar-detail__text">
      <h3 className="nx-group-label">{label}</h3>
      <p>{text}</p>
    </section>
  )
}

/** Pause/resume. Optimistic: flips at once and rolls back if the server
 *  refuses. Only active and paused events get it: a finished or cancelled
 *  one has nothing left to resume. */
function StatusRow({ ev }: { ev: CalendarEvent }) {
  const nt = useNT()
  const [on, setOn] = useState(ev.status === 'active')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setOn(ev.status === 'active'), [ev.status])
  return (
    <div className="nx-rows">
      <div className="nx-row nx-calendar-status">
        <span className="nx-row__text">
          <span>{nt('calendar.active')}</span>
          <span className="nx-row__hint">{nt(on ? 'calendar.activeHint' : 'calendar.pausedHint')}</span>
        </span>
        {busy && <Spinner />}
        <Switch
          label={nt('calendar.active')}
          checked={on}
          disabled={busy}
          onChange={async (v) => {
            setOn(v)
            setBusy(true)
            setError(null)
            try {
              await useCalendar.getState().update(ev.id, { status: v ? 'active' : 'paused' })
            } catch (e) {
              setOn(!v)
              setError(errText(e))
            } finally {
              setBusy(false)
            }
          }}
        />
      </div>
      {error && <p className="nx-field__error nx-calendar-detail__error" role="alert">{error}</p>}
    </div>
  )
}

function DeleteButton({ ev, onDeleted }: { ev: CalendarEvent; onDeleted: () => void }) {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className="nx-btn nx-btn--danger"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(nt('calendar.deleteConfirm', { title: ev.title || nt('calendar.untitled') }))) return
          setBusy(true)
          setError(null)
          try {
            await useCalendar.getState().remove(ev.id)
            haptic('success')
            onDeleted()
          } catch (e) {
            haptic('error')
            setError(errText(e))
            setBusy(false)
          }
        }}
      >
        {busy && <Spinner />}
        {nt('calendar.delete')}
      </button>
      {error && <p className="nx-field__error nx-calendar-detail__error" role="alert">{error}</p>}
    </>
  )
}

function RunRow({ d }: { d: CalendarDispatch }) {
  const nt = useNT()
  const locale = useLocale()
  const messageId = d.messageId
  return (
    <li className="nx-calendar-run" data-status={d.status}>
      <span className="nx-calendar-run__icon" aria-hidden>
        {d.status === 'dispatched' ? <ICheck /> : d.status === 'failed' ? <IX /> : d.status === 'pending' ? <Spinner /> : <span className="nx-calendar-run__dot" />}
      </span>
      <span className="nx-calendar-run__text">
        <span>{runLabel(d.status, nt)}</span>
        <time className="nx-calendar-run__time nx-mono" dateTime={d.scheduledFor}>{stampLabel(new Date(d.scheduledFor), locale)}</time>
        {d.error && <span className="nx-calendar-run__err">{d.error}</span>}
      </span>
      {d.conversationId && messageId && (
        <a
          className="nx-btn nx-btn--sm"
          href={href({ section: 'chats', id: d.conversationId })}
          onClick={(e) => {
            linkClick(e)
            // ChatView consumes the jump once the transcript is mounted. In a
            // room's panel this link also leaves the event peek, which useApp
            // still holds until the next render; clear it with the jump, or
            // the legacy-write bridge reads it back and reopens the peek.
            if (e.defaultPrevented) useApp.setState({ pendingJumpMessageId: messageId, openCalendarEventId: null })
          }}
        >{nt('calendar.openMessage')}</a>
      )}
    </li>
  )
}

/** Dispatch history. Refetches when the scheduler fires (`lastFiredAt`
 *  moves) or after Run now, which leaves `lastFiredAt` alone. A refresh
 *  keeps the rows and spins next to the heading. */
function Runs({ ev, nonce }: { ev: CalendarEvent; nonce: number }) {
  const nt = useNT()
  const [list, setList] = useState<CalendarDispatch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setBusy(true)
    api.listCalendarDispatches(ev.id)
      .then((r) => {
        if (!live) return
        setList(r.dispatches.slice(0, RUNS_SHOWN))
        setError(null)
      })
      .catch((e) => { if (live) setError(errText(e)) })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [ev.id, ev.lastFiredAt, nonce, attempt])
  return (
    <section className="nx-calendar-runs" aria-busy={busy || undefined}>
      <h3 className="nx-group-label nx-calendar-runs__head">{nt('calendar.runs')}{busy && list && <Spinner />}</h3>
      {error ? (
        <div className="nx-calendar-runs__error" role="alert">
          <span>{nt('calendar.runsFailed')}</span>
          <button type="button" className="nx-btn nx-btn--sm nx-btn--outline" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
            {busy && <Spinner />}{nt('calendar.retry')}
          </button>
        </div>
      ) : list === null ? (
        <div className="nx-calendar-runs__wait"><Spinner /></div>
      ) : list.length === 0 ? (
        <p className="nx-calendar-runs__none">{nt('calendar.runsNone')}</p>
      ) : (
        <ol className="nx-calendar-runs__list">{list.map((d) => <RunRow key={d.id} d={d} />)}</ol>
      )}
    </section>
  )
}

function EventBody({ ev, stack, onClose, editHref }: { ev: CalendarEvent; stack: boolean; onClose: () => void; editHref?: string }) {
  const nt = useNT()
  const route = useRoute()
  const locale = useLocale()
  const me = useMe()
  const assignee = useParticipants((s) => (ev.assigneeId ? s.byId[ev.assigneeId] : undefined))
  const room = useConversations((s) => (ev.targetConversationId ? s.list.find((c) => c.id === ev.targetConversationId) : undefined))
  const [nonce, setNonce] = useState(0)
  const start = new Date(ev.startAt)
  const agent = ev.kind === 'agent_task'
  // A one-shot's next time is its own start, already under "When".
  const next = ev.recurrence && ev.status === 'active' ? nextOccurrenceOnOrAfter(start, ev.recurrence, new Date()) : null
  return (
    <aside className="nx-calendar-detail" aria-label={nt('calendar.detail')}>
      <DetailBar stack={stack} onClose={onClose}>
        <a className="nx-btn nx-btn--sm nx-btn--outline" href={editHref ?? withRoute(route, { params: { ...EDITOR_PARAMS, edit: '1' } })} onClick={linkClick}>
          <IPencil />{nt('calendar.edit')}
        </a>
      </DetailBar>
      <div className="nx-calendar-detail__body nx-scroll">
        <div className="nx-calendar-detail__title">
          <KindMark ev={ev} size={36} />
          <div>
            <h2>{ev.title || nt('calendar.untitled')}</h2>
            <p>
              {[
                nt(agent ? 'calendar.agentTask' : 'calendar.personal'),
                nt(`calendar.state.${ev.status}`),
                ev.isPrivate ? nt('calendar.private') : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        {(ev.status === 'active' || ev.status === 'paused') && <StatusRow ev={ev} />}
        <div className="nx-rows">
          <Kv label={nt('calendar.when')}>
            {whenLabel(ev, locale)} <span className="nx-calendar-kv__zone nx-mono">{zoneName(start, locale)}</span>
          </Kv>
          <Kv label={nt('calendar.repeats')}>{describeRepeat(ev.recurrence, nt, locale)}</Kv>
          {next && <Kv label={nt('calendar.upNext')}>{stampLabel(next, locale)}</Kv>}
          <Kv label={nt('calendar.reminder')}>{describeReminder(ev, nt, locale)}</Kv>
          <Kv label={nt('calendar.visibility')}>{nt(ev.isPrivate ? 'calendar.visPrivate' : 'calendar.visShared')}</Kv>
        </div>
        {agent && (
          <div className="nx-rows">
            <Kv label={nt('calendar.assignee')}>
              {!assignee ? nt('calendar.nobody') : assignee.kind === 'agent' ? (
                <a className="nx-calendar-detail__who" href={href({ section: 'agents', id: assignee.id })} onClick={linkClick}>
                  <Avatar p={assignee} size={20} presence />{assignee.name}
                </a>
              ) : (
                <span className="nx-calendar-detail__who"><Avatar p={assignee} size={20} />{assignee.name}</span>
              )}
            </Kv>
            <Kv label={nt('calendar.postsIn')}>
              {room ? (
                <a className="nx-calendar-detail__who" href={href({ section: 'chats', id: room.id })} onClick={linkClick}>
                  {room.kind === 'direct' ? <IChat /> : room.kind === 'email' ? <IMail /> : <IHash />}{room.title}
                </a>
              ) : nt(ev.targetConversationId ? 'calendar.postsInHidden' : 'calendar.postsInDirect')}
            </Kv>
          </div>
        )}
        {ev.agentPrompt && <TextBlock label={nt('calendar.prompt')} text={ev.agentPrompt} />}
        {ev.description && <TextBlock label={nt('calendar.notes')} text={ev.description} />}
        <div className="nx-calendar-detail__actions">
          {agent && <RunNow ev={ev} onRan={() => setNonce((n) => n + 1)} />}
          {ev.createdBy === me && <DeleteButton ev={ev} onDeleted={onClose} />}
        </div>
        {agent && <Runs ev={ev} nonce={nonce} />}
        <p className="nx-calendar-detail__meta">
          {nt('calendar.stamps', { created: dateLabel(new Date(ev.createdAt), locale), updated: dateLabel(new Date(ev.updatedAt), locale) })}
        </p>
      </div>
    </aside>
  )
}

/** `editHref` is for hosts outside the Calendar section, where the editor does not live. */
export function EventDetail({ rawId, stack, onClose, editHref }: {
  rawId: string
  stack: boolean
  onClose: () => void
  editHref?: string
}) {
  const nt = useNT()
  const id = useResolvedCalendarId(rawId)
  const event = useCalendar((s) => s.events.find((e) => e.id === id))
  const listSettled = useCalendar((s) => s.loaded || (!s.loading && s.error !== null))
  const [missing, setMissing] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The last copy seen keeps the sheet drawn while it closes after a delete.
  const last = useRef<CalendarEvent | undefined>(undefined)
  if (event) last.current = event

  useEffect(() => {
    if (event) return
    if (last.current) {
      // Deleted while open (here, in the editor, or by someone else):
      // nothing is left to show, so close in place, in Calendar (`?event=`)
      // or in a room's panel (an event peek).
      const r = getRoute()
      if (r.search.get('event') === rawId || (r.peek?.kind === 'event' && r.peek.id === rawId)) {
        navigate(withRoute(r, { peek: null, params: { ...EDITOR_PARAMS, event: null } }), { replace: true })
      }
      return
    }
    if (!listSettled) return
    let live = true
    setMissing(null)
    useCalendar.getState().loadEvent(id).catch((e) => { if (live) setMissing(errText(e)) })
    return () => { live = false }
  }, [event, listSettled, id, rawId, attempt])

  const shown = event ?? last.current
  if (shown) return <EventBody ev={shown} stack={stack} onClose={onClose} editHref={editHref} />
  return (
    <aside className="nx-calendar-detail" aria-label={nt('calendar.detail')}>
      <DetailBar stack={stack} onClose={onClose} />
      {missing ? (
        <div className="nx-empty nx-calendar-detail__gone" role="alert">
          <b>{nt('calendar.unavailable')}</b>
          <span>{nt('calendar.unavailableBody')}</span>
          <span className="nx-mono">{missing}</span>
          <button type="button" className="nx-btn nx-btn--outline" onClick={() => setAttempt((n) => n + 1)}>{nt('calendar.retry')}</button>
        </div>
      ) : (
        <div className="nx-center" aria-busy="true"><Spinner large label={nt('calendar.opening')} /></div>
      )}
    </aside>
  )
}
