/**
 * Coding: the T3 Code threads the room's agents launched, at the top of the
 * Details tab. The server copies them from T3 once a minute
 * (server/src/fork/coding.ts), so the group reloads every 30 seconds while
 * it is open. It shows only when an agent has a thread or a T3 server fails,
 * so a room without coding keeps its Details tab as it was. A thread with a
 * pull request opens the newest one; T3 has no address a phone can open.
 * Owners and admins only, like the agent fields below it.
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
  pullRequests: Array<{ number: number; url: string; state: string }>
  createdAt: string
  updatedAt: string
}
interface Coding { threads: Thread[]; servers: Array<{ name: string; error: string | null }> }

const RELOAD_MS = 30_000
// T3's thread statuses, in the words and colours the row uses.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

function look(status: string): { label: NKey; tone: string; icon: JSX.Element } {
  if (ACTIVE.has(status)) return { label: 'coding.running', tone: 'live', icon: <Spinner /> }
  if (status === 'waiting') return { label: 'coding.waiting', tone: 'warn', icon: <IInfo aria-hidden /> }
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
  const when = relative(ACTIVE.has(t.status) ? t.createdAt : t.updatedAt, locale)
  const body = (
    <>
      {icon}
      {agent && <Avatar p={agent} size={20} />}
      <span className="nx-row__text">
        <span className="nx-coding__title">{t.title}</span>
        <span className="nx-row__hint">{[nt(label), when, server ? t.server : null].filter(Boolean).join(' · ')}</span>
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
  const [coding, setCoding] = useState<Array<Coding & { agentId: string }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setCoding(null)
    setError(null)
    const load = async () => {
      if (document.hidden) return
      try {
        const lists = await Promise.all(ids.split(' ').map(async (agentId) =>
          ({ agentId, ...(await http<Coding>(`/fork/agents/${encodeURIComponent(agentId)}/coding`)) })))
        if (!live) return
        setCoding(lists)
        setError(null)
      } catch (e) {
        if (live) setError(errText(e))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), RELOAD_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [ids])

  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = (coding ?? [])
    .flatMap((c) => c.threads.map((t) => ({ t, agent: byId.get(c.agentId) })))
    .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))
  const servers = coding?.[0]?.servers ?? []
  const failing = servers.filter((s) => s.error)
  if (rows.length === 0 && failing.length === 0 && !error) return null
  return (
    <section className="nx-details__group" aria-label={nt('coding.head')}>
      <h3 className="nx-details__head"><IComputer aria-hidden />{nt('coding.head')}</h3>
      {rows.length > 0 && (
        <div className="nx-rows">
          {rows.map(({ t, agent }) => (
            <CodingRow key={`${t.server} ${t.threadId}`} t={t} agent={agents.length > 1 ? agent : undefined} server={servers.length > 1} />
          ))}
        </div>
      )}
      {failing.map((s) => <p key={s.name} className="nx-field__error" role="alert">{nt('coding.serverError', { server: s.name, error: s.error ?? '' })}</p>)}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
    </section>
  )
}
