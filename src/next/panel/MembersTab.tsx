import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import type { Conversation, Participant } from '@/types'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { getRoute, navigate, withRoute } from '../router'
import { useOpenDirect } from '../hooks'
import { Avatar } from '../ui/Avatar'
import { Dialog, IconButton, Spinner } from '../ui/primitives'
import { ICompose, IPlus } from '../ui/icons'

function statusLabel(p: Participant, nt: ReturnType<typeof useNT>): string {
  if (p.kind === 'human') return nt('members.human')
  if (p.status === 'working' || p.status === 'thinking') return nt('activity.working')
  if (p.status === 'waiting') return nt('members.waiting')
  if (p.status === 'avail') return nt('members.online')
  return nt('members.offline')
}

function AddPeople({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const nt = useNT()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const candidates = useParticipants(useShallow((s) => Object.values(s.byId)
    .filter((p) => !c.members.includes(p.id) && !p.departedAt)
    .sort((a, b) => a.name.localeCompare(b.name))))
  const shown = candidates.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
  const add = async (p: Participant) => {
    setBusy(p.id)
    try {
      await api.addMember(c.id, p.id)
      await useConversations.getState().reload()
      haptic('success')
    } catch (e) {
      haptic('error')
      console.warn('[next] add member failed', e)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onClose={onClose} title={nt('members.addTitle', { room: c.title })}>
      <input className="nx-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={nt('members.search')} aria-label={nt('members.search')} />
      <div className="nx-people">
        {shown.length === 0 && <div className="nx-empty">{nt('members.nobody')}</div>}
        {shown.map((p) => (
          <button key={p.id} type="button" className="nx-person" disabled={busy !== null} onClick={() => void add(p)}>
            <Avatar p={p} size={32} presence />
            <span className="nx-person__text"><b>{p.name}</b><span>{p.role ?? statusLabel(p, nt)}</span></span>
            {busy === p.id ? <Spinner /> : <IPlus className="nx-person__act" />}
          </button>
        ))}
      </div>
    </Dialog>
  )
}

export function MembersTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const me = useMe()
  const openDirect = useOpenDirect()
  const [adding, setAdding] = useState(false)
  const people = useParticipants(useShallow((s) => c.members.map((id) => s.byId[id]).filter((p): p is Participant => !!p)))
  const sorted = useMemo(() => [...people].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1
    return a.name.localeCompare(b.name)
  }), [people])
  return (
    <div className="nx-people">
      {c.kind === 'group' && (
        <button type="button" className="nx-person nx-person--add" onClick={() => setAdding(true)}>
          <span className="nx-room-glyph"><IPlus /></span>
          <span className="nx-person__text"><b>{nt('members.add')}</b></span>
        </button>
      )}
      {sorted.map((p) => (
        <div key={p.id} className="nx-person">
          <button
            type="button"
            className="nx-person__open"
            onClick={() => navigate(withRoute(getRoute(), { peek: { kind: 'agent', id: p.id }, threadId: null }))}
          >
            <Avatar p={p} size={32} presence />
            <span className="nx-person__text">
              <b>{p.name}{p.id === me ? ` · ${nt('members.you')}` : ''}</b>
              <span>{p.role ? `${p.role} · ${statusLabel(p, nt)}` : statusLabel(p, nt)}</span>
            </span>
          </button>
          {p.id !== me && (
            <IconButton small label={nt('chats.message', { name: p.name })} onClick={() => void openDirect(p.id)}><ICompose /></IconButton>
          )}
        </div>
      ))}
      {adding && <AddPeople c={c} onClose={() => setAdding(false)} />}
    </div>
  )
}
