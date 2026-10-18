/**
 * Agents at work in the room peek over the composer bar. Every agent that
 * shows "typing" here gets a head that rises from behind the bar when it
 * starts and ducks back when it stops, so the transcript keeps no row for
 * them and the bar gains one fixed band however many agents work: past the
 * cap the rest share one "+N" head. A mouse hovering a head names it; a click
 * on the heads (a tap on touch) lists everyone at work, with a stop button for
 * the agents whose engine can stop a turn.
 */
import { memo, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { canStopAgent, stopAgent } from '@/lib/agentStop'
import { useMe } from '@/stores/auth'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'
import { elapsed } from '../format'
import { haptic } from '../haptics'
import { useNow } from '../hooks'
import { useNT } from '../i18n'
import { useLayout } from '../layout'
import { getRoute, navigate, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { IconButton, Menu, Spinner, T_FAST, useCoarse, useMenu } from '../ui/primitives'
import { IStop } from '../ui/icons'

/** When each agent's head first showed, per room. It keeps the heads in the
 *  order they came (the store moves an agent to the end of the typing list on
 *  every ping) and times them. */
const firstSeen = new Map<string, Map<string, number>>()

// An agent that stops typing is forgotten at once, so its next turn counts
// from zero and joins the end of the row, even when it ran in a room that was not on screen.
useMessages.subscribe((s, prev) => {
  if (s.typing === prev.typing) return
  for (const [convoId, seen] of firstSeen) {
    const typing = s.typing[convoId] ?? []
    for (const id of seen.keys()) if (!typing.includes(id)) seen.delete(id)
  }
})

const Head = memo(function Head({ p, x, size, since }: { p: Participant; x: number; size: number; since: number }) {
  const [hover, setHover] = useState(false)
  const now = useNow(hover)
  return (
    <motion.span
      className="nx-heads__head"
      initial={{ x, y: size }}
      animate={{ x, y: 0 }}
      exit={{ y: size }}
      transition={T_FAST}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true) }}
      onPointerLeave={() => setHover(false)}
    >
      {/* Heads further right bob later, so the row never moves in step. */}
      <span className="nx-heads__bob" style={{ animationDelay: `${-x / 150}s` }}>
        <Avatar p={p} size={size} />
      </span>
      {hover && <span className="nx-tooltip nx-heads__tag">{p.name}<span className="nx-mono">{elapsed(now - since)}</span></span>}
    </motion.span>
  )
})

/** Rows mount only while the list is open, so their clock ticks only then. */
function WorkingRow({ convoId, p, since, onClose }: { convoId: string; p: Participant; since: number; onClose: () => void }) {
  const nt = useNT()
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const stop = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await stopAgent(convoId, p.id)
      haptic('success')
    } catch (e) {
      haptic('error')
      setFailed(true)
      console.warn('[next] stop agent failed', e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nx-person">
      <button
        type="button"
        className="nx-person__open"
        onClick={() => {
          onClose()
          navigate(withRoute(getRoute(), { peek: { kind: 'agent', id: p.id }, threadId: null }))
        }}
      >
        <Avatar p={p} size={28} presence />
        <span className="nx-person__text">
          <b>{p.name}</b>
          {failed
            ? <span className="nx-heads__failed" role="alert">{nt('composer.stopFailed')}</span>
            : <span className="nx-mono">{elapsed(now - since)}</span>}
        </span>
      </button>
      {canStopAgent(p) && (
        <IconButton small label={nt('composer.stop', { name: p.name })} disabled={busy} aria-busy={busy || undefined} onClick={() => void stop()}>
          {busy ? <Spinner /> : <IStop />}
        </IconButton>
      )}
    </div>
  )
}

export function WorkingHeads({ convoId }: { convoId: string }) {
  const nt = useNT()
  const me = useMe()
  const coarse = useCoarse()
  const cap = useLayout() === 'stack' ? 6 : 9
  const menu = useMenu()
  // Sorted and joined, so a ping that only reorders the typing list renders nothing.
  const ids = useMessages((s) => (s.typing[convoId] ?? []).filter((id) => id !== me).sort().join(','))
  const ps = useParticipants(useShallow((s) => (ids ? ids.split(',') : [])
    .map((id) => s.byId[id])
    .filter((p): p is Participant => !!p)))

  const seen = firstSeen.get(convoId) ?? new Map<string, number>()
  firstSeen.set(convoId, seen)
  const t = Date.now()
  for (const p of ps) if (!seen.has(p.id)) seen.set(p.id, t)
  const at = (id: string) => seen.get(id) ?? t
  const agents = [...ps].sort((a, b) => at(a.id) - at(b.id))
  // Prefer the server's status clock: it survives a reload mid-turn.
  const sinceOf = (p: Participant) => Math.min(
    at(p.id),
    p.statusUpdatedAt && (p.status === 'working' || p.status === 'thinking') ? new Date(p.statusUpdatedAt).getTime() : Infinity,
  )

  const { close } = menu
  useEffect(() => { if (agents.length === 0) close() }, [agents.length, close])

  const size = coarse ? 32 : 28
  const step = size + (coarse ? 4 : 6)
  const shown = agents.length > cap ? agents.slice(0, cap - 1) : agents
  const rest = agents.length - shown.length

  return (
    <>
      {/* Heads already up when the room opens stay put, like the messages; later ones rise. */}
      <AnimatePresence initial={false}>
        {agents.length > 0 && (
          <motion.button
            key="heads"
            type="button"
            className="nx-heads"
            style={{ width: (Math.min(agents.length, cap) - 1) * step + size, height: size }}
            initial={{ y: size }}
            animate={{ y: 0 }}
            exit={{ y: size }}
            transition={T_FAST}
            aria-label={agents.length === 1 ? nt('chat.oneWorking', { name: agents[0].name }) : nt('chat.manyWorking', { n: agents.length })}
            aria-haspopup="menu"
            onClick={(e) => {
              // The bar sits at the bottom of the screen, so the list opens above the heads.
              const r = e.currentTarget.getBoundingClientRect()
              menu.openAt({ x: r.left, y: r.top, align: 'start' })
            }}
          >
            <AnimatePresence initial={false}>
              {shown.map((p, i) => (
                <Head key={p.id} p={p} x={i * step} size={size} since={sinceOf(p)} />
              ))}
              {rest > 0 && (
                <motion.span
                  key="rest"
                  className="nx-heads__head"
                  initial={{ x: shown.length * step, y: size }}
                  animate={{ x: shown.length * step, y: 0 }}
                  exit={{ y: size }}
                  transition={T_FAST}
                >
                  <span className="nx-heads__more nx-mono" style={{ width: size, height: size }}>+{rest}</span>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        )}
      </AnimatePresence>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={close}
        entries={[]}
        header={(
          <div className="nx-heads__list nx-scroll">
            <div className="nx-menu__label">{nt('panel.workingNow')}</div>
            {agents.map((p) => <WorkingRow key={p.id} convoId={convoId} p={p} since={sinceOf(p)} onClose={close} />)}
          </div>
        )}
      />
    </>
  )
}
