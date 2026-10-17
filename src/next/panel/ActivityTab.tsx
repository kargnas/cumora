/**
 * What the agents in this room are doing and have done.
 *
 * Today's sources: live status (`participants.status`), typing and token
 * streams per room, and tool/thought messages when an engine posts them.
 * Owners/admins with developer tools on also get the server's run records
 * (stage, tool count, tokens, events). Local (BYOA) engines do not report
 * individual tool calls yet, so for them a turn shows its timing and result.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api, type ApiAgentEvent, type ApiAgentRun } from '@/api/client'
import { useApp } from '@/stores/app'
import { useDevtools } from '@/stores/devtools'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Conversation, Message, Participant } from '@/types'
import { useNT } from '../i18n'
import { clock, duration, elapsed } from '../format'
import { useNow } from '../hooks'
import { Avatar } from '../ui/Avatar'
import { Spinner, T_MEDIUM } from '../ui/primitives'
import { ICheck, IChevronDown, IX } from '../ui/icons'
import { createdAt } from '../chat/model'
import { useRoomAgents } from '../chat/ChatView'

const EMPTY: Message[] = []
const TURN_LIMIT = 12

interface Turn {
  key: string
  author: string
  reply: Message
  steps: Message[]
  /** Last human message before the reply: what the agent was answering. */
  askedAt: Date | null
  at: Date
}

/** Pair each agent reply with the tool/thought rows it produced and the
 *  human message it answered, newest first. */
function useTurns(c: Conversation, byId: Record<string, Participant>): Turn[] {
  const messages = useMessages((s) => s.byConvo[c.id] ?? EMPTY)
  return useMemo(() => {
    const out: Turn[] = []
    const work = new Map<string, Message[]>()
    let asked: Date | null = null
    for (const m of messages) {
      const who = byId[m.authorId]
      if (m.kind === 'tool' || m.kind === 'thought') {
        work.set(m.authorId, [...(work.get(m.authorId) ?? []), m])
        continue
      }
      if (m.kind === 'system' || m.kind === 'whisper-link') continue
      if (who?.kind === 'human') { asked = createdAt(m); continue }
      if (who?.kind !== 'agent') continue
      const at = createdAt(m)
      out.push({ key: m.id, author: m.authorId, reply: m, steps: work.get(m.authorId) ?? [], askedAt: asked, at })
      work.delete(m.authorId)
    }
    return out.slice(-TURN_LIMIT).reverse()
  }, [messages, byId])
}

/* ── Live ───────────────────────────────────────────────────────────── */
function LiveCard({ p, convoId, run }: { p: Participant; convoId: string; run: ApiAgentRun | undefined }) {
  const nt = useNT()
  const now = useNow()
  const typingHere = useMessages((s) => (s.typing[convoId] ?? []).includes(p.id))
  const streamingHere = useMessages((s) => Object.values(s.streaming).some((x) => x.conversationId === convoId && x.authorId === p.id))
  const since = run ? new Date(run.startedAt).getTime() : p.statusUpdatedAt ? new Date(p.statusUpdatedAt).getTime() : now
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
        <div className="nx-shimmer">{run?.stage ? `${state} · ${run.stage}` : state}</div>
        {run && (run.toolCallCount > 0 || run.tokenCount > 0) && (
          <div className="nx-live__meta nx-mono">
            {run.toolCallCount > 0 && <span>{nt('activity.tools', { n: run.toolCallCount })}</span>}
            {run.tokenCount > 0 && <span>{nt('activity.tokens', { n: Math.round(run.tokenCount / 100) / 10 })}</span>}
          </div>
        )}
      </div>
    </motion.div>
  )
}

/* ── History ────────────────────────────────────────────────────────── */
const TurnCard = memo(function TurnCard({ turn, author }: { turn: Turn; author: Participant | undefined }) {
  const nt = useNT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const took = turn.askedAt ? turn.at.getTime() - turn.askedAt.getTime() : null
  const preview = turn.reply.body.replace(/\s+/g, ' ').trim()
  return (
    <div className="nx-turn">
      <button type="button" className="nx-turn__head" onClick={() => useApp.getState().jumpToMessage(turn.reply.id)}>
        {author && <Avatar p={author} size={20} />}
        <b>{author?.name ?? nt('msg.someone')}</b>
        <span className="nx-turn__took">{took !== null && took > 0 && took < 6 * 3600_000 ? nt('activity.repliedIn', { t: duration(took) }) : nt('activity.replied')}</span>
        <time className="nx-mono" dateTime={turn.at.toISOString()}>{clock(turn.at, locale)}</time>
      </button>
      {preview && <p className="nx-turn__preview">{preview}</p>}
      {turn.steps.length > 0 && (
        <>
          <button type="button" className="nx-turn__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <IChevronDown style={{ transform: open ? 'rotate(180deg)' : undefined }} />
            {nt('activity.steps', { n: turn.steps.length })}
          </button>
          {/* transitions-dev 21: accordion on grid rows, no height measuring. */}
          <div className="nx-acc" data-open={open || undefined}>
            <ol className="nx-steps">
              {turn.steps.map((s) => (
                <li key={s.id} className="nx-step">
                  <span className="nx-step__icon" data-ok={s.kind === 'tool' && !/error|fail|forbidden|invalid/i.test(s.tool?.status ?? '') ? '' : undefined}>
                    {s.kind === 'tool' ? <ICheck /> : <span className="nx-step__dot" />}
                  </span>
                  <span className="nx-step__text">
                    <span>{s.kind === 'tool' ? s.tool?.name ?? nt('activity.tool') : nt('activity.thought')}</span>
                    <span className="nx-step__detail nx-mono">{s.kind === 'tool' ? [s.tool?.arg, s.tool?.status].filter(Boolean).join(' · ') : s.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </div>
  )
})

/* ── Runs (developer tools) ─────────────────────────────────────────── */
function RunRow({ run }: { run: ApiAgentRun }) {
  const nt = useNT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<ApiAgentEvent[] | null>(null)
  useEffect(() => {
    if (!open || events) return
    api.getAgentRunEvents(run.id).then(setEvents).catch(() => setEvents([]))
  }, [open, events, run.id])
  const failed = run.status === 'failed' || run.status === 'stalled'
  return (
    <div className="nx-run" data-status={run.status}>
      <button type="button" className="nx-run__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="nx-run__state">{run.status === 'running' ? <Spinner /> : failed ? <IX /> : <ICheck />}</span>
        <span className="nx-run__text">
          <b>{run.agentName}</b>
          <span>{run.error ?? run.summary ?? run.stage ?? nt(`run.${run.status}`)}</span>
        </span>
        <span className="nx-run__meta nx-mono">
          {run.status === 'running' ? clock(new Date(run.startedAt), locale) : duration(run.durationMs)}
        </span>
      </button>
      <div className="nx-acc" data-open={open || undefined}>
        <div className="nx-run__body">
          <div className="nx-run__facts nx-mono">
            <span>{nt('activity.tools', { n: run.toolCallCount })}</span>
            <span>{nt('activity.tokens', { n: Math.round(run.tokenCount / 100) / 10 })}</span>
            {typeof run.trigger.engine === 'string' && <span>{run.trigger.engine}</span>}
          </div>
          {events === null && open && <Spinner />}
          {events && events.length > 0 && (
            <ol className="nx-steps">
              {events.map((e) => (
                <li key={e.id} className="nx-step" data-level={e.level}>
                  <span className="nx-step__icon"><span className="nx-step__dot" /></span>
                  <span className="nx-step__text">
                    <span>{e.title}</span>
                    <span className="nx-step__detail nx-mono">{clock(new Date(e.createdAt), locale)} · {e.kind}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}

/** Runs of this room's agents whose inbox included a message from this room. */
function useRoomRuns(c: Conversation, agentIds: string[], liveKey: string): ApiAgentRun[] | null {
  const enabled = useDevtools((s) => s.enabled)
  const messages = useMessages((s) => s.byConvo[c.id] ?? EMPTY)
  const [runs, setRuns] = useState<ApiAgentRun[] | null>(null)
  const ids = useMemo(() => new Set(messages.map((m) => m.id)), [messages])
  const agentKey = agentIds.join(',')
  useEffect(() => {
    if (!enabled || agentIds.length === 0) { setRuns(null); return }
    let cancelled = false
    const load = () => Promise.all(agentIds.map((id) => api.getAgentRuns({ agentId: id, limit: 8 }).catch(() => [] as ApiAgentRun[])))
      .then((lists) => { if (!cancelled) setRuns(lists.flat()) })
    void load()
    // While someone works, keep the open run's stage and counters fresh.
    const timer = liveKey ? window.setInterval(load, 8000) : undefined
    return () => { cancelled = true; if (timer) window.clearInterval(timer) }
    // agentKey stands in for agentIds, which is a new array on every render.
  }, [enabled, agentKey, liveKey])
  return useMemo(() => {
    if (!runs) return null
    return runs
      .filter((r) => r.status === 'running' || r.inputMessageIds.some((id) => ids.has(id)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 10)
  }, [runs, ids])
}

export function ActivityTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const byId = useParticipants((s) => s.byId)
  const { agents, live } = useRoomAgents(c)
  const turns = useTurns(c, byId)
  const liveKey = live.map((p) => p.id).join(',')
  const runs = useRoomRuns(c, agents.map((p) => p.id), liveKey)
  const runningBy = useMemo(() => new Map((runs ?? []).filter((r) => r.status === 'running').map((r) => [r.agentId, r])), [runs])

  return (
    <div className="nx-activity">
      <AnimatePresence initial={false}>
        {live.map((p) => <LiveCard key={p.id} p={p} convoId={c.id} run={runningBy.get(p.id)} />)}
      </AnimatePresence>
      {live.length === 0 && turns.length === 0 && (
        <div className="nx-empty">{agents.length > 0 ? nt('activity.idle') : nt('activity.noAgents')}</div>
      )}
      {turns.length > 0 && <h3 className="nx-group-label">{nt('activity.recent')}</h3>}
      {turns.map((t) => <TurnCard key={t.key} turn={t} author={byId[t.author]} />)}
      {runs && runs.length > 0 && (
        <>
          <h3 className="nx-group-label">{nt('activity.runs')}</h3>
          {runs.map((r) => <RunRow key={r.id} run={r} />)}
        </>
      )}
    </div>
  )
}
