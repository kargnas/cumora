/**
 * The agent menu: one live menu for every place that names an agent. An
 * element inside the app marked `data-agent-id` opens it on a click, a
 * right-click (a long press on Android), Enter or Space while it has focus,
 * and the context-menu key. Agents wall tiles and list rows open the agent on
 * a click, so they open this menu through `useHold` and `openAgentMenu`.
 *
 * It shows what the agent is doing now, what it owns (its screen and its T3
 * Code threads, for owners and admins), how to talk to it and what to do with
 * it, and it keeps updating while it is open. Inside a chat its panes open in
 * the room panel's agent drawer, so the conversation stays in view; anywhere
 * else they open the agent's page in Agents.
 */
import { useCallback } from 'react'
import { create } from 'zustand'
import { getServerOrigin } from '@/api/client'
import { canStopAgent, stopAgent } from '@/lib/agentStop'
import { copyText } from '@/lib/clipboard'
import { useLocale } from '@/lib/i18n'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'
import { relative } from './format'
import { haptic } from './haptics'
import { useAdmin, useOpenDirect } from './hooks'
import { useNT } from './i18n'
import { getRoute, href, navigate, useRoute, withRoute } from './router'
import { Avatar } from './ui/Avatar'
import { anchorFrom, Menu, type MenuAnchor, type MenuEntry, type MenuItem } from './ui/primitives'
import { IAgents, IAt, ICode, ICompose, IComputer, ICopy, IStop } from './ui/icons'
import { isOpenThread, look, newestThreads, threadTime, useCoding, type Thread } from './panel/CodingTab'
import { agentState, hasWork, StateText } from './sections/agents/shared'

/** The agent drawer's panes (`?pane=` beside `peek=agent:<id>`). */
export type AgentPane = 'screen' | 'jobs' | 'profile'

// The menu keeps its agent after it closes, so the exit animation still has rows.
const useAgentMenu = create<{ id: string | null; anchor: MenuAnchor | null }>(() => ({ id: null, anchor: null }))

export function openAgentMenu(id: string, anchor: MenuAnchor): void {
  useAgentMenu.setState({ id, anchor })
}

/** Props that let an avatar or a name open the menu; nothing for a person. */
export function agentRef(p: Participant | undefined): { 'data-agent-id': string; role: 'button'; tabIndex: 0 } | undefined {
  return p?.kind === 'agent' ? { 'data-agent-id': p.id, role: 'button', tabIndex: 0 } : undefined
}

/**
 * Binds the triggers on the app's root element. The listeners sit below
 * React's root, so they run before React's own handlers and stop them: a
 * click on a classic @mention chip opens this menu, not the chip's profile.
 */
export function bindAgentRefs(root: HTMLElement): () => void {
  let touchedAt = Number.NEGATIVE_INFINITY
  const hit = (e: Event): { el: HTMLElement; id: string } | null => {
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-agent-id]')
    const id = el?.dataset.agentId
    return el && id ? { el, id } : null
  }
  const onTouch = () => { touchedAt = Date.now() }
  const onClick = (e: MouseEvent) => {
    const h = hit(e)
    if (!h || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    openAgentMenu(h.id, anchorFrom(h.el))
  }
  const onContext = (e: MouseEvent) => {
    const h = hit(e)
    if (!h) return
    e.preventDefault()
    e.stopPropagation()
    // On Android a long press arrives as this event, so it plays the hold.
    if (Date.now() - touchedAt < 1_000) haptic('hold')
    // The keyboard's context-menu key reports no pointer position.
    const keyboard = e.clientX === 0 && e.clientY === 0
    openAgentMenu(h.id, keyboard ? anchorFrom(h.el) : { x: e.clientX, y: e.clientY })
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const h = hit(e)
    if (!h || h.el !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    openAgentMenu(h.id, anchorFrom(h.el))
  }
  root.addEventListener('touchstart', onTouch, { passive: true })
  root.addEventListener('click', onClick)
  root.addEventListener('contextmenu', onContext)
  root.addEventListener('keydown', onKey)
  return () => {
    root.removeEventListener('touchstart', onTouch)
    root.removeEventListener('click', onClick)
    root.removeEventListener('contextmenu', onContext)
    root.removeEventListener('keydown', onKey)
  }
}

/** Opens one of the agent's panes: the room panel's drawer inside a chat,
 *  the agent's page in Agents anywhere else. */
export function openAgentPane(id: string, pane: AgentPane): void {
  const r = getRoute()
  if (r.section === 'chats' && r.id) {
    const same = r.peek?.kind === 'agent' && r.peek.id === id
    navigate(withRoute(r, { peek: { kind: 'agent', id }, threadId: null, params: { pane } }), { replace: same })
    return
  }
  // The workspace shows the screen and the threads together.
  const view = pane === 'profile' ? 'profile' : null
  navigate(r.section === 'agents'
    ? withRoute(r, { id, params: { view, since: null, at: null } })
    : href({ section: 'agents', id, params: { view } }))
}

/** A thread with a pull request opens it, as its row does in the Coding list. */
function openThread(t: Thread, agentId: string): void {
  const pr = t.pullRequests[t.pullRequests.length - 1]
  if (pr) window.open(pr.url, '_blank', 'noopener,noreferrer')
  else openAgentPane(agentId, 'jobs')
}

function copyLink(id: string): void {
  // The native apps run from a local origin; the server's is the one a link can open.
  const url = `${getServerOrigin() || location.origin}${href({ section: 'agents', id })}`
  copyText(url).catch((e) => {
    haptic('error')
    console.warn('[next] copy agent link failed', e)
  })
}

function Head({ p, now }: { p: Participant; now: Thread | undefined }) {
  const nt = useNT()
  const host = useComputers((s) => (p.computerId ? s.byId[p.computerId] : undefined))
  return (
    <div className="nx-agent-menu__head">
      <Avatar p={p} size={32} presence={!p.departedAt} />
      <span className="nx-agent-menu__who">
        <b>{p.name}</b>
        <span>
          {p.role && <span>{p.role} · </span>}
          <StateText p={p} state={agentState(p, host)} />
        </span>
        {now && <span className="nx-agent-menu__now">{nt('agentMenu.now', { title: now.title })}</span>}
      </span>
    </div>
  )
}

export function AgentMenuHost() {
  const nt = useNT()
  const locale = useLocale()
  const admin = useAdmin()
  const route = useRoute()
  const openDirect = useOpenDirect()
  const id = useAgentMenu((s) => s.id)
  const anchor = useAgentMenu((s) => s.anchor)
  const close = useCallback(() => useAgentMenu.setState({ anchor: null }), [])
  const found = useParticipants((s) => (id ? s.byId[id] : undefined))
  const p = found?.kind === 'agent' ? found : undefined
  const host = useComputers((s) => (p?.computerId ? s.byId[p.computerId] : undefined))
  const roomId = route.section === 'chats' ? route.id : null
  const inRoom = useConversations((s) => !!p && !!roomId && !!s.list.find((c) => c.id === roomId)?.members.includes(p.id))
  const open = anchor !== null && p !== undefined
  const active = !!p && !p.departedAt
  const working = !!p && admin && hasWork(p)
  const { coding } = useCoding(p?.id ?? '', open && working)

  if (!p) return <Menu open={false} anchor={null} entries={[]} onClose={close} />

  const threads = working && coding ? newestThreads(coding).map((x) => x.t) : []
  const running = threads.filter(isOpenThread)
  const state = agentState(p, host)
  const live = state === 'working' || state === 'thinking'

  const owned: MenuItem[] = working ? [
    {
      key: 'screen',
      label: nt('agentMenu.screen'),
      icon: <IComputer />,
      detail: live ? <span className="nx-live-tag">{nt('agentMenu.live')}</span> : undefined,
      shortcut: 'S',
      onSelect: () => openAgentPane(p.id, 'screen'),
    },
    {
      key: 'jobs',
      label: nt('agentMenu.jobs'),
      icon: <ICode />,
      detail: coding ? nt('agentMenu.jobsCount', { active: running.length, total: threads.length }) : undefined,
      shortcut: 'J',
      onSelect: () => openAgentPane(p.id, 'jobs'),
    },
    ...threads.slice(0, 3).map((t): MenuItem => {
      const { tone, icon } = look(t.status)
      return {
        key: `thread-${t.server}-${t.threadId}`,
        label: t.title,
        icon: <span className="nx-agent-menu__thread" data-tone={tone}>{icon}</span>,
        detail: relative(threadTime(t), locale),
        onSelect: () => openThread(t, p.id),
      }
    }),
  ] : []
  const talk: MenuItem[] = active ? [
    {
      key: 'message',
      label: nt('agentMenu.message'),
      icon: <ICompose />,
      shortcut: 'M',
      onSelect: () => {
        openDirect(p.id).catch((e) => {
          haptic('error')
          console.warn('[next] open direct failed', e)
        })
      },
    },
    // Composer adds `@id` to this room's draft (src/next/chat/Composer.tsx).
    ...(inRoom ? [{
      key: 'mention',
      label: nt('agentMenu.mention'),
      icon: <IAt />,
      shortcut: '@',
      onSelect: () => window.dispatchEvent(new CustomEvent('nx:mention', { detail: p.id })),
    }] : []),
  ] : []
  // The server stops a turn per room (server/src/fork/stop.ts), so Stop needs one.
  const stopRoom = active && inRoom && live && canStopAgent(p) ? roomId : null
  const control: MenuItem[] = [
    ...(stopRoom ? [{
      key: 'stop',
      label: nt('agentMenu.stop'),
      icon: <IStop />,
      danger: true,
      shortcut: 'X',
      onSelect: () => {
        stopAgent(stopRoom, p.id).then(() => haptic('success'), (e) => {
          haptic('error')
          console.warn('[next] stop agent failed', e)
        })
      },
    }] : []),
    { key: 'profile', label: nt('agentMenu.profile'), icon: <IAgents />, shortcut: 'I', onSelect: () => openAgentPane(p.id, 'profile') },
    { key: 'copy', label: nt('agentMenu.copyLink'), icon: <ICopy />, shortcut: 'C', onSelect: () => copyLink(p.id) },
  ]
  const entries: MenuEntry[] = [owned, talk, control]
    .filter((g) => g.length > 0)
    .flatMap((g, i): MenuEntry[] => (i > 0 ? ['sep', ...g] : g))

  return (
    <Menu
      open={open}
      anchor={anchor}
      onClose={close}
      entries={entries}
      header={<Head p={p} now={running[0]} />}
    />
  )
}
