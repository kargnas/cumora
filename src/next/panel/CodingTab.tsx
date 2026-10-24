/**
 * Coding: the T3 Code threads the room's agents launched. The server copies
 * them from T3 (server/src/fork/coding.ts) and says on the workspace's socket
 * when its copy changed, so the tab reads the list again then, and the last
 * answer per agent draws the list at once when the tab opens again. A thread
 * with pull requests opens the last one T3 lists; T3 has no address a phone
 * can open. Owners and admins only, because a title an agent wrote can quote
 * any room. The agent drawer, the Agents wall and workspace and the agent menu
 * read the same lists through `useCoding`.
 */
import { useEffect, useState } from 'react'
import { http, ws } from '@/api/client'
import { useLocale } from '@/lib/i18n'
import type { Conversation, Participant } from '@/types'
import { relative } from '../format'
import { useAdmin } from '../hooks'
import { useNT, type NKey } from '../i18n'
import { Avatar } from '../ui/Avatar'
import { Spinner } from '../ui/primitives'
import { ICheck, IInfo, IStop, IX } from '../ui/icons'
import { errText } from '../sections/calendar/parts'
import { useRoomAgents } from '../chat/ChatView'

export interface Thread {
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

// T3's thread statuses, in the words and colours the row uses. T3 shows a run
// that just finished as `waiting` while it saves the checkpoint, and counts it
// as running; 'question' is the server's, for a thread that waits for an answer.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

/** Still going: running, or stopped on a question for someone. */
export const isOpenThread = (t: Thread): boolean => ACTIVE.has(t.status) || t.status === 'question'

// The last answer for each agent, so the list draws at once when the tab opens
// again, and its entrance plays only the first time (src/next/AGENTS.md).
const cache = new Map<string, Coding>()
const cached = (ids: string): AgentCoding[] | null => {
  const lists = ids.split(' ').map((agentId) => {
    const c = cache.get(agentId)
    return c ? { agentId, ...c } : null
  })
  return lists.every((l) => l !== null) ? (lists as AgentCoding[]) : null
}

export function look(status: string): { label: NKey; tone: string; icon: JSX.Element } {
  if (status === 'question') return { label: 'coding.waiting', tone: 'warn', icon: <IInfo aria-hidden /> }
  if (ACTIVE.has(status)) return { label: 'coding.running', tone: 'live', icon: <Spinner /> }
  if (status === 'completed') return { label: 'coding.completed', tone: 'live', icon: <ICheck aria-hidden /> }
  if (status === 'failed') return { label: 'coding.failed', tone: 'bad', icon: <IX aria-hidden /> }
  if (STOPPED.has(status)) return { label: 'coding.stopped', tone: 'muted', icon: <IStop aria-hidden /> }
  return { label: 'coding.idle', tone: 'muted', icon: <span className="nx-coding__dot" aria-hidden /> }
}

/** The pull request a thread's row opens: the last one T3 lists. */
export const lastPr = (t: Thread): Thread['pullRequests'][number] | undefined => t.pullRequests[t.pullRequests.length - 1]

/** A running thread counts from its start, a resting one from when it stopped. */
export const threadTime = (t: Thread): string => (isOpenThread(t) ? t.createdAt : t.updatedAt)

/** Newest first, every agent's threads in one list. */
export const newestThreads = (coding: AgentCoding[]): Array<{ t: Thread; agentId: string }> => coding
  .flatMap((c) => c.threads.map((t) => ({ t, agentId: c.agentId })))
  .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))

/**
 * The threads of some agents (`ids`, space-joined), read again whenever the
 * server's copy changes. `enabled` false skips the reads, for a viewer the
 * route refuses or a menu that is closed.
 */
export function useCoding(ids: string, enabled = true): { coding: AgentCoding[] | null; fresh: boolean; error: string | null } {
  const [coding, setCoding] = useState(() => cached(ids))
  // Only a list that arrives with a first answer fades in.
  const [fresh, setFresh] = useState(() => cached(ids) === null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    // An event can start a read while an older one is still out; only the
    // newest may draw.
    let latest = 0
    const hit = cached(ids)
    setCoding(hit)
    setFresh(hit === null)
    setError(null)
    const load = async () => {
      if (document.hidden) return
      const mine = ++latest
      try {
        const lists = await Promise.all(ids.split(' ').map(async (agentId) =>
          ({ agentId, ...(await http<Coding>(`/fork/agents/${encodeURIComponent(agentId)}/coding`)) })))
        if (!live || mine !== latest) return
        for (const { agentId, threads, servers } of lists) cache.set(agentId, { threads, servers })
        setCoding(lists)
        setError(null)
      } catch (e) {
        if (live && mine === latest) setError(errText(e))
      }
    }
    // Back from the background, the list may be minutes old.
    const onVisible = () => { if (!document.hidden) void load() }
    // `fork.coding` (a fork event, outside the client's event union) says the
    // server's copy changed. `hello` opens every connection, after events missed
    // while the socket was down.
    const off = ws.on((e) => {
      if (e.type === 'hello' || (e as { type: string }).type === 'fork.coding') void load()
    })
    void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      off()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ids, enabled])
  // While reads are off, the state can still hold the lists of agents asked
  // about before (the menu reopened on someone else); those never show.
  const own = coding !== null && coding.map((c) => c.agentId).join(' ') === ids
  return { coding: own ? coding : null, fresh, error }
}

function CodingRow({ t, agent, server }: { t: Thread; agent?: Participant; server: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const { label, tone, icon } = look(t.status)
  const pr = lastPr(t)
  const when = relative(threadTime(t), locale)
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

/** The threads of `agents`, newest first; a face on each row once there are several agents. */
export function CodingList({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const { coding, fresh, error } = useCoding(agents.map((a) => a.id).join(' '))

  if (coding === null) {
    return error
      ? <div className="nx-empty" role="alert">{error}</div>
      : <div className="nx-center" aria-busy="true"><Spinner /></div>
  }
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = newestThreads(coding)
  const servers = coding[0]?.servers ?? []
  return (
    <>
      {rows.length === 0
        ? <div className="nx-empty">{nt(agents.length === 1 ? 'coding.noneAgent' : 'coding.none')}</div>
        : (
          <div className={fresh ? 'nx-rows nx-coding-list' : 'nx-rows'}>
            {rows.map(({ t, agentId }) => (
              <CodingRow key={`${t.server} ${t.threadId}`} t={t} agent={agents.length > 1 ? byId.get(agentId) : undefined} server={servers.length > 1} />
            ))}
          </div>
        )}
      {/* A failing T3 server may be holding threads back, even when none show. */}
      {servers.filter((s) => s.error).map((s) => <p key={s.name} className="nx-field__error" role="alert">{nt('coding.serverError', { server: s.name, error: s.error ?? '' })}</p>)}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
    </>
  )
}

export function CodingTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const { agents } = useRoomAgents(c)
  const admin = useAdmin()
  if (agents.length === 0) return <div className="nx-empty">{nt('panel.noAgents')}</div>
  if (!admin) return <div className="nx-empty"><b>{nt('coding.locked')}</b>{nt('coding.lockedBody')}</div>
  return <CodingList agents={agents} />
}
