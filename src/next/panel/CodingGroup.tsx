/**
 * Coding: the T3 Code threads the room's agents launched, in the Details tab
 * under the agents. The server copies them from T3 once a minute
 * (server/src/fork/coding.ts), so the group reloads every 30 seconds while
 * it is open. It shows only when an agent has a thread, so a room without
 * coding keeps its Details tab as it was. It sits below the room's fields and
 * the agents, so its arrival after the first answer moves nothing a finger may
 * be heading for, and the last answer per agent draws it at once when the tab
 * opens again. A thread with pull requests opens the last one T3 lists; T3
 * has no address a phone can open. Owners and admins only, like the agent fields.
 */
import { useEffect, useState } from 'react'
import { http } from '@/api/client'
import { useLocale } from '@/lib/i18n'
import type { Participant } from '@/types'
import { relative } from '../format'
import { useNT, type NKey } from '../i18n'
import { Avatar } from '../ui/Avatar'
import { Spinner } from '../ui/primitives'
import { ICheck, IComputer, IInfo, IStop, IX } from '../ui/icons'
import { errText } from '../sections/calendar/parts'

interface Thread {
  server: string
  threadId: string
  title: string
  status: string
  pullRequests: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  updatedAt: string
}
interface Coding { threads: Thread[]; servers: Array<{ name: string; error: string | null }> }
type AgentCoding = Coding & { agentId: string }

const RELOAD_MS = 30_000
// T3's thread statuses, in the words and colours the row uses. T3 shows a run
// that just finished as `waiting` while it saves the checkpoint, and counts it
// as running; 'question' is the server's, for a thread that waits for an answer.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

// The last answer for each agent, so the group draws at once when the tab opens
// again, and its entrance plays only the first time (src/next/AGENTS.md).
const cache = new Map<string, Coding>()
const cached = (ids: string): AgentCoding[] | null => {
  const lists = ids.split(' ').map((agentId) => {
    const c = cache.get(agentId)
    return c ? { agentId, ...c } : null
  })
  return lists.every((l) => l !== null) ? (lists as AgentCoding[]) : null
}

function look(status: string): { label: NKey; tone: string; icon: JSX.Element } {
  if (status === 'question') return { label: 'coding.waiting', tone: 'warn', icon: <IInfo aria-hidden /> }
  if (ACTIVE.has(status)) return { label: 'coding.running', tone: 'live', icon: <Spinner /> }
  if (status === 'completed') return { label: 'coding.completed', tone: 'live', icon: <ICheck aria-hidden /> }
  if (status === 'failed') return { label: 'coding.failed', tone: 'bad', icon: <IX aria-hidden /> }
  if (STOPPED.has(status)) return { label: 'coding.stopped', tone: 'muted', icon: <IStop aria-hidden /> }
  return { label: 'coding.idle', tone: 'muted', icon: <span className="nx-coding__dot" aria-hidden /> }
}

function CodingRow({ t, agent, server }: { t: Thread; agent?: Participant; server: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const { label, tone, icon } = look(t.status)
  const pr = t.pullRequests[t.pullRequests.length - 1]
  // A running thread counts from its start, a resting one from when it stopped.
  const when = relative(ACTIVE.has(t.status) || t.status === 'question' ? t.createdAt : t.updatedAt, locale)
  const body = (
    <>
      {icon}
      {agent && <Avatar p={agent} size={20} />}
      <span className="nx-row__text">
        <span className="nx-coding__title">{t.title}</span>
        {/* The avatar is hidden from screen readers, so the hint names the agent. */}
        <span className="nx-row__hint">{[agent?.name, nt(label), when, server ? t.server : null].filter(Boolean).join(' · ')}</span>
      </span>
      {t.pullRequests.map((p) => <span key={p.url} className="nx-chip nx-mono">#{p.number}</span>)}
    </>
  )
  return pr
    ? <a className="nx-row nx-row--link nx-coding" data-tone={tone} href={pr.url} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="nx-row nx-coding" data-tone={tone}>{body}</div>
}

export function CodingGroup({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const ids = agents.map((a) => a.id).join(' ')
  const [coding, setCoding] = useState(() => cached(ids))
  // Only a group that arrives with a first answer fades in.
  const [rise, setRise] = useState(() => cached(ids) === null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const hit = cached(ids)
    setCoding(hit)
    setRise(hit === null)
    setError(null)
    const load = async () => {
      if (document.hidden) return
      try {
        const lists = await Promise.all(ids.split(' ').map(async (agentId) =>
          ({ agentId, ...(await http<Coding>(`/fork/agents/${encodeURIComponent(agentId)}/coding`)) })))
        if (!live) return
        for (const { agentId, threads, servers } of lists) cache.set(agentId, { threads, servers })
        setCoding(lists)
        setError(null)
      } catch (e) {
        if (live) setError(errText(e))
      }
    }
    // Back from the background, the list may be minutes old.
    const onVisible = () => { if (!document.hidden) void load() }
    void load()
    const timer = window.setInterval(() => void load(), RELOAD_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ids])

  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = (coding ?? [])
    .flatMap((c) => c.threads.map((t) => ({ t, agent: byId.get(c.agentId) })))
    .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))
  // A failing T3 server is a note under the threads it may be holding back; a
  // room whose agents have none shows nothing, whatever the servers do.
  if (rows.length === 0) return null
  const servers = coding?.[0]?.servers ?? []
  return (
    <section className={rise ? 'nx-details__group nx-coding-group' : 'nx-details__group'} aria-label={nt('coding.head')}>
      <h3 className="nx-details__head"><IComputer aria-hidden />{nt('coding.head')}</h3>
      <div className="nx-rows">
        {rows.map(({ t, agent }) => (
          <CodingRow key={`${t.server} ${t.threadId}`} t={t} agent={agents.length > 1 ? agent : undefined} server={servers.length > 1} />
        ))}
      </div>
      {servers.filter((s) => s.error).map((s) => <p key={s.name} className="nx-field__error" role="alert">{nt('coding.serverError', { server: s.name, error: s.error ?? '' })}</p>)}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
    </section>
  )
}
