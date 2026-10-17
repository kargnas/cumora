/**
 * What the agents in this room are doing, and what their runs did that the
 * chat does not show.
 *
 * Live cards come from participant status and the room's typing and token
 * streams. Below them, each recent run of an agent in the room says what it
 * changed (cards, docs, events, posts in other rooms), what went wrong, and
 * its time and cost. Steps sit behind a toggle and exist only when the engine
 * reported them: cloud agents do, BYOA engines do not. The runs come from
 * server/src/fork/activity.ts through ./activity.ts.
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '@/stores/app'
import { useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Conversation, Participant } from '@/types'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { clock, duration, elapsed, listStamp } from '../format'
import { useNow } from '../hooks'
import { getRoute, href, navigate, withRoute, type Peek } from '../router'
import { Avatar } from '../ui/Avatar'
import { Spinner, T_MEDIUM } from '../ui/primitives'
import {
  IAgents, IArrowRight, IBoard, ICalendar, IChat, ICheck, IChevronDown, IDoc, IPencil, IRepeat, IThread, ITrash, IX,
} from '../ui/icons'
import { useRoomAgents } from '../chat/ChatView'
import {
  useRoomActivity, usd,
  type ActivityEffect, type ActivityProblem, type ActivityRun, type EffectKind, type EffectRef, type RoutineFailure,
} from './activity'

/* ── Live ───────────────────────────────────────────────────────────── */
function LiveCard({ p, convoId }: { p: Participant; convoId: string }) {
  const nt = useNT()
  const now = useNow()
  const typingHere = useMessages((s) => (s.typing[convoId] ?? []).includes(p.id))
  const streamingHere = useMessages((s) => Object.values(s.streaming).some((x) => x.conversationId === convoId && x.authorId === p.id))
  const since = p.statusUpdatedAt ? new Date(p.statusUpdatedAt).getTime() : now
  const state = streamingHere ? nt('activity.writing')
    : typingHere ? nt('activity.composing')
      : p.status === 'thinking' ? nt('activity.thinking')
        : nt('activity.working')
  return (
    <motion.div className="nx-live" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={T_MEDIUM}>
      <Avatar p={p} size={32} presence />
      <div className="nx-live__main">
        <div className="nx-live__top">
          <b>{p.name}</b>
          <span className="nx-mono">{elapsed(now - since)}</span>
        </div>
        <div className="nx-shimmer">{state}</div>
      </div>
    </motion.div>
  )
}

/* ── Runs ───────────────────────────────────────────────────────────── */

/** When each card was first shown. A card animates in only during its first
 *  ENTRANCE_MS, so reopening the tab or a poll never replays the entrance. */
const firstSeen = new Map<string, number>()
const ENTRANCE_MS = 700
function entering(id: string): boolean {
  const t = firstSeen.get(id)
  if (t === undefined) { firstSeen.set(id, performance.now()); return true }
  return performance.now() - t < ENTRANCE_MS
}

const EFFECT_ICON: Record<EffectKind, typeof IBoard> = {
  'card.created': IBoard,
  'card.moved': IArrowRight,
  'card.updated': IPencil,
  'card.deleted': ITrash,
  'comment.created': IThread,
  'board.created': IBoard,
  'doc.created': IDoc,
  'doc.edited': IPencil,
  'doc.deleted': ITrash,
  'event.created': ICalendar,
  'message.posted': IChat,
}

function openRef(ref: EffectRef): void {
  if (ref.type === 'room') {
    navigate(href({ section: 'chats', id: ref.id }))
    // ChatView consumes this once the transcript is mounted.
    useApp.getState().jumpToMessage(ref.messageId)
    return
  }
  const peek: Peek = ref.type === 'board' ? { kind: 'board', id: ref.id, cardId: ref.cardId }
    : ref.type === 'doc' ? { kind: 'doc', id: ref.id }
      : { kind: 'event', id: ref.id }
  navigate(withRoute(getRoute(), { peek }))
}

function Effect({ e }: { e: ActivityEffect }) {
  const nt = useNT()
  const roomId = e.ref?.type === 'room' ? e.ref.id : null
  const room = useConversations((s) => (roomId ? s.list.find((c) => c.id === roomId) : undefined))
  const Icon = EFFECT_ICON[e.kind]
  // A direct room is titled after the other member, and the agent that posted
  // in the viewer's direct room is that member: "Posted in Atlas" would read wrong.
  const text = room?.kind === 'direct' ? nt('activity.effect.message.direct')
    : nt(`activity.effect.${e.kind}`, {
      title: e.title ?? '',
      where: e.kind === 'message.posted' ? room?.title ?? nt('activity.otherRoom') : e.where ?? '',
    })
  const body = (
    <>
      <Icon aria-hidden />
      <span className="nx-run__text">{text}</span>
      {e.count > 1 && (e.kind === 'message.posted' || e.kind === 'comment.created') && <span className="nx-run__count nx-mono">×{e.count}</span>}
    </>
  )
  const ref = e.ref
  return (
    <li>
      {ref
        ? <button type="button" className="nx-run__item" onClick={() => openRef(ref)}>{body}</button>
        : <div className="nx-run__item">{body}</div>}
    </li>
  )
}

function Problem({ p, since }: { p: ActivityProblem; since: string }) {
  const nt = useNT()
  const locale = useLocale()
  const head = p.kind === 'failed' ? nt('activity.problem.failed')
    : p.kind === 'stalled' ? nt('activity.problem.stalled', { time: clock(new Date(since), locale) })
      : p.kind === 'step' ? nt('activity.problem.step', { name: p.title ?? '' })
        : p.title ?? nt('activity.problem.failed')
  return (
    <li className="nx-run__item nx-run__item--bad">
      <IX aria-hidden />
      <span className="nx-run__text">
        <span>{head}</span>
        {p.text && <span className="nx-run__detail">{p.text}</span>}
      </span>
    </li>
  )
}

function stepTime(ms: number): string {
  return ms < 1000 ? `${ms}ms` : duration(ms)
}

/** Avatar, name and `meta` on the top row, `sub` under the name. */
function Head({ agentId, glyph, meta, sub }: { agentId: string | null; glyph: ReactNode; meta?: ReactNode; sub: ReactNode }) {
  const nt = useNT()
  const agent = useParticipants((s) => (agentId ? s.byId[agentId] : undefined))
  return (
    <div className="nx-run__head">
      {agent ? <Avatar p={agent} size={24} /> : <span className="nx-run__glyph">{glyph}</span>}
      <div className="nx-run__main">
        <div className="nx-run__top">
          <b>{agent?.name ?? nt('msg.someone')}</b>
          {meta}
        </div>
        <div className="nx-run__sub">{sub}</div>
      </div>
    </div>
  )
}

const RunCard = memo(function RunCard({ run }: { run: ActivityRun }) {
  const nt = useNT()
  const locale = useLocale()
  const [stepsOpen, setStepsOpen] = useState(false)
  const skipped = run.status === 'skipped'
  const cost = run.costUsd > 0 ? `${run.costEstimated ? '~' : ''}${usd(run.costUsd)}` : null
  return (
    <article className="nx-run" data-status={run.status} data-enter={entering(run.id) || undefined}>
      <Head
        agentId={run.agentId}
        glyph={<IAgents />}
        meta={!skipped && <span className="nx-mono">{duration(run.durationMs)}{cost && ` · ${cost}`}</span>}
        sub={(
          <>
            <time className="nx-mono" dateTime={run.startedAt}>{listStamp(run.startedAt, locale)}</time>
            {run.status !== 'completed' && <span className="nx-run__state">{nt(`run.${run.status}`)}</span>}
            {run.model && <span className="nx-run__model nx-mono">{run.model}</span>}
          </>
        )}
      />
      {skipped && run.summary && <p className="nx-run__note">{run.summary}</p>}
      {run.effects.length > 0 && (
        <div className="nx-run__part">
          <h4 className="nx-run__label">{nt('activity.changed')}</h4>
          <ul className="nx-run__list">{run.effects.map((e, i) => <Effect key={i} e={e} />)}</ul>
        </div>
      )}
      {run.problems.length > 0 && (
        <div className="nx-run__part">
          <h4 className="nx-run__label">{nt('activity.wentWrong')}</h4>
          <ul className="nx-run__list">{run.problems.map((p, i) => <Problem key={i} p={p} since={run.updatedAt} />)}</ul>
        </div>
      )}
      {run.stepCount > 0 && (
        <>
          <button
            type="button"
            className="nx-run__toggle"
            aria-expanded={stepsOpen}
            onClick={() => { haptic('select'); setStepsOpen((v) => !v) }}
          >
            <IChevronDown aria-hidden />
            {stepsOpen ? nt('activity.hideSteps') : nt('activity.showSteps', { n: run.stepCount })}
          </button>
          {/* Shown at once rather than grown open: height is never animated
              here (AGENTS.md, smoothness), only the list fades in. */}
          {stepsOpen && (
            <ol className="nx-steps">
              {run.steps.map((s, i) => (
                <li key={i} className="nx-step" data-state={s.ok === null ? 'running' : s.ok ? 'ok' : 'failed'}>
                  <span className="nx-step__icon">{s.ok === null ? <Spinner /> : s.ok ? <ICheck aria-hidden /> : <IX aria-hidden />}</span>
                  <span className="nx-step__text">
                    <span>{s.name}{s.ok === false && s.status && <span className="nx-mono"> · {s.status}</span>}</span>
                    {s.text && <span className="nx-step__detail nx-mono">{s.text}</span>}
                  </span>
                  {s.durationMs !== null && <span className="nx-step__time nx-mono">{stepTime(s.durationMs)}</span>}
                </li>
              ))}
              {run.stepCount > run.steps.length && (
                <li className="nx-step nx-step__more">{nt('activity.stepsCapped', { n: run.steps.length, total: run.stepCount })}</li>
              )}
            </ol>
          )}
        </>
      )}
    </article>
  )
})

const RoutineCard = memo(function RoutineCard({ r }: { r: RoutineFailure }) {
  const nt = useNT()
  const locale = useLocale()
  return (
    <article className="nx-run" data-status="failed" data-enter={entering(r.id) || undefined}>
      <Head
        agentId={r.agentId}
        glyph={<IRepeat />}
        sub={(
          <>
            <time className="nx-mono" dateTime={r.at}>{listStamp(r.at, locale)}</time>
            <span>{nt('activity.routine')}</span>
          </>
        )}
      />
      <div className="nx-run__part">
        <h4 className="nx-run__label">{nt('activity.wentWrong')}</h4>
        <ul className="nx-run__list">
          <li className="nx-run__item nx-run__item--bad">
            <IX aria-hidden />
            <span className="nx-run__text">
              <span>{nt('activity.problem.routine', { title: r.title ?? '' })}</span>
              {r.text && <span className="nx-run__detail">{r.text}</span>}
            </span>
          </li>
        </ul>
      </div>
    </article>
  )
})

function Skeleton() {
  return (
    <div className="nx-activity__skel" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="nx-run">
          <div className="nx-run__head">
            <span className="nx-skel" style={{ width: 24, height: 24, borderRadius: 999 }} />
            <div className="nx-run__main">
              <span className="nx-skel" style={{ width: '40%', height: 12 }} />
              <span className="nx-skel" style={{ width: '25%', height: 10 }} />
            </div>
          </div>
          <span className="nx-skel" style={{ width: '70%', height: 10 }} />
        </div>
      ))}
    </div>
  )
}

type Item = { at: string; run: ActivityRun; routine?: never } | { at: string; routine: RoutineFailure; run?: never }

export function ActivityTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const { agents, live } = useRoomAgents(c)
  const liveKey = live.map((p) => p.id).join(',')
  const { data, failed, retry } = useRoomActivity(c.id, live.length > 0)

  const items = useMemo(() => {
    if (!data) return []
    // A live agent's open run is its live card above; it joins the list once it ends.
    const liveIds = new Set(liveKey.split(','))
    const list: Item[] = [
      ...data.runs.filter((r) => !(r.status === 'running' && liveIds.has(r.agentId))).map((run) => ({ at: run.startedAt, run })),
      ...data.routines.map((routine) => ({ at: routine.at, routine })),
    ]
    return list.sort((a, b) => b.at.localeCompare(a.at))
  }, [data, liveKey])

  return (
    <div className="nx-activity">
      <AnimatePresence initial={false}>
        {live.map((p) => <LiveCard key={p.id} p={p} convoId={c.id} />)}
      </AnimatePresence>
      {failed && <button type="button" className="nx-activity__error" onClick={retry}>{nt('activity.loadFailed')}</button>}
      {!data && !failed && <Skeleton />}
      {data && live.length === 0 && items.length === 0 && (
        <div className="nx-empty">{agents.length > 0 ? nt('activity.idle') : nt('activity.noAgents')}</div>
      )}
      {items.length > 0 && <h3 className="nx-group-label">{nt('activity.runs')}</h3>}
      {items.map((i) => (i.run ? <RunCard key={i.run.id} run={i.run} /> : <RoutineCard key={i.routine.id} r={i.routine} />))}
    </div>
  )
}
