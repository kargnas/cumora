/**
 * Coding: the T3 Code threads the room's agents launched. The server copies
 * them from T3 (server/src/fork/coding.ts) and says on the workspace's socket
 * when its copy changed, so the tab reads the list again then, and the last
 * answer per agent draws the list at once when the tab opens again. A thread
 * with pull requests opens the last one T3 lists; T3 has no address a phone
 * can open. Owners and admins only, because a title an agent wrote can quote
 * any room.
 */
import { useEffect, useState } from 'react'
import { http, ws } from '@/api/client'
import { useLocale } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'
import type { Conversation, Participant } from '@/types'
import { relative } from '../format'
import { useNT, type NKey } from '../i18n'
import { Avatar } from '../ui/Avatar'
import { Spinner } from '../ui/primitives'
import { ICheck, IInfo, IStop, IX } from '../ui/icons'
import { errText } from '../sections/calendar/parts'
import { useRoomAgents } from '../chat/ChatView'

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

// T3's thread statuses, in the words and colours the row uses. T3 shows a run
// that just finished as `waiting` while it saves the checkpoint, and counts it
// as running; 'question' is the server's, for a thread that waits for an answer.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

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

function CodingList({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const ids = agents.map((a) => a.id).join(' ')
  const [coding, setCoding] = useState(() => cached(ids))
  // Only a list that arrives with a first answer fades in.
  const [rise, setRise] = useState(() => cached(ids) === null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // An event can start a read while an older one is still out; only the
    // newest may draw.
    let latest = 0
    const hit = cached(ids)
    setCoding(hit)
    setRise(hit === null)
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
  }, [ids])

  if (coding === null) {
    return error
      ? <div className="nx-empty" role="alert">{error}</div>
      : <div className="nx-center" aria-busy="true"><Spinner /></div>
  }
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = coding
    .flatMap((c) => c.threads.map((t) => ({ t, agent: byId.get(c.agentId) })))
    .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))
  const servers = coding[0]?.servers ?? []
  return (
    <>
      {rows.length === 0
        ? <div className="nx-empty">{nt('coding.none')}</div>
        : (
          <div className={rise ? 'nx-rows nx-coding-list' : 'nx-rows'}>
            {rows.map(({ t, agent }) => (
              <CodingRow key={`${t.server} ${t.threadId}`} t={t} agent={agents.length > 1 ? agent : undefined} server={servers.length > 1} />
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
  const admin = useAuth((s) => {
    const role = s.companies.find((x) => x.id === s.activeCompanyId)?.role
    return role === 'owner' || role === 'admin'
  })
  if (agents.length === 0) return <div className="nx-empty">{nt('panel.noAgents')}</div>
  if (!admin) return <div className="nx-empty"><b>{nt('coding.locked')}</b>{nt('coding.lockedBody')}</div>
  return <CodingList agents={agents} />
}
