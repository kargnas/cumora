/**
 * Edit: the room's own settings and, for workspace owners and admins, the
 * room's agent, in a dialog over the chat (`?edit=1`). The room's name in the
 * chat header and the pencil in the room panel's header open it. The agents
 * come from the chat header, which already follows them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AgentInput } from '@/api/client'
import { isMuted, useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import type { Conversation, Participant } from '@/types'
import { haptic } from '../haptics'
import { useAdmin } from '../hooks'
import { useNT } from '../i18n'
import { getRoute, goBack, href, linkClick, navigate, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { Dialog, Spinner, Switch } from '../ui/primitives'
import { ICheck, IChevronRight, IConvene, IExit, IHash } from '../ui/icons'
import { AgentChips, usePickedAgent } from './AgentChips'
import { AGENT_EDIT_PARAM, AgentEditDialog } from './AgentEditDialog'

const EDIT_PARAM = 'edit'

/** Opens Edit over the room on screen. A push, so Back closes it. */
export function openEdit(): void {
  navigate(withRoute(getRoute(), { params: { [EDIT_PARAM]: '1' } }))
}

/** A field that saves on blur/Enter and shows its own pending state, so an
 *  edit never blocks the rest of the dialog. */
function EditableField({ label, value, multiline, rows = 3, placeholder, onSave }: {
  label: string
  value: string
  multiline?: boolean
  rows?: number
  placeholder?: string
  onSave: (v: string) => Promise<unknown>
}) {
  const nt = useNT()
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(value), [value])
  // "Saved" stays for a moment after the server answers, then the label is plain again.
  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(false), 2000)
    return () => window.clearTimeout(t)
  }, [saved])
  const commit = async () => {
    if (draft.trim() === value.trim()) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await onSave(draft.trim())
      await useConversations.getState().reload()
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDraft(value)
    } finally {
      setSaving(false)
    }
  }
  const common = {
    className: 'nx-input',
    value: draft,
    placeholder,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-busy': saving || undefined,
    onBlur: () => void commit(),
  }
  return (
    <label className="nx-field">
      <span className="nx-field__label">
        {label}
        {saving && <Spinner />}
        {saved && <span className="nx-field__saved" role="status"><ICheck aria-hidden />{nt('edit.saved')}</span>}
      </span>
      {multiline
        ? <textarea {...common} rows={rows} onChange={(e) => setDraft(e.target.value)} />
        : <input {...common} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />}
      {error && <span className="nx-field__error" role="alert">{error}</span>}
    </label>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  // Optimistic: flip at once, roll back if the server says no.
  const [local, setLocal] = useState(checked)
  useEffect(() => setLocal(checked), [checked])
  return (
    <div className="nx-row">
      <span className="nx-row__text"><span>{label}</span>{hint && <span className="nx-row__hint">{hint}</span>}</span>
      {busy && <Spinner />}
      <Switch
        label={label}
        checked={local}
        onChange={async (v) => {
          setLocal(v)
          setBusy(true)
          try {
            await onChange(v)
            await useConversations.getState().reload()
          } catch {
            setLocal(!v)
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}

/** The picked agent's own settings. They follow the agent into every room,
 *  which the scope line says; the server lets only owners and admins save
 *  them. The rest (model, computer, avatar) is in the full editor. */
function AgentGroup({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const route = useRoute()
  const a = usePickedAgent(agents)
  if (!a) return null
  const save = async (patch: AgentInput) => {
    await api.updateAgent(a.id, patch)
    // The panel header, the roster and the 1:1 room's title show these.
    await useParticipants.getState().refresh()
  }
  return (
    <section className="nx-edit__group" aria-label={a.name}>
      <AgentChips agents={agents} picked={a} />
      <h3 className="nx-edit__head"><Avatar p={a} size={20} />{a.name}</h3>
      <p className="nx-edit__scope">{nt('edit.agentScope', { name: a.name })}</p>
      {/* Keyed by agent: a draft never carries over to another agent. */}
      <EditableField
        key={`${a.id}:name`}
        label={nt('edit.agentName')}
        value={a.name}
        onSave={(v) => (v ? save({ name: v }) : Promise.reject(new Error(nt('edit.agentNameRequired'))))}
      />
      <EditableField key={`${a.id}:role`} label={nt('edit.agentRole')} value={a.role ?? ''} onSave={(v) => save({ role: v })} />
      <EditableField key={`${a.id}:bio`} label={nt('edit.agentBio')} value={a.bio ?? ''} multiline onSave={(v) => save({ bio: v })} />
      <EditableField
        key={`${a.id}:style`}
        label={nt('edit.agentStyle')}
        value={a.systemPrompt ?? ''}
        multiline
        rows={6}
        // An empty style blanks the agent's persona in every room; the full editor refuses it too.
        onSave={(v) => (v ? save({ systemPrompt: v }) : Promise.reject(new Error(nt('edit.agentStyleRequired'))))}
      />
      <div className="nx-rows">
        <a className="nx-row nx-row--link" href={withRoute(route, { params: { [AGENT_EDIT_PARAM]: a.id } })} onClick={linkClick}>
          <span className="nx-row__text"><span>{nt('edit.agentMore')}</span></span>
          <span className="nx-row__value nx-mono">{a.model ?? nt('agents.modelDefault')}</span>
          <IChevronRight aria-hidden />
        </a>
      </div>
    </section>
  )
}

function RoomEdit({ c, agents }: { c: Conversation; agents: Participant[] }) {
  const nt = useNT()
  const [convening, setConvening] = useState(false)
  const admin = useAdmin()
  const muted = isMuted(c)
  const canRename = c.kind === 'group'
  return (
    <div className="nx-edit">
      <section className="nx-edit__group" aria-label={nt('edit.thisRoom')}>
        <h3 className="nx-edit__head"><IHash aria-hidden />{nt('edit.thisRoom')}</h3>
        {canRename && <EditableField label={nt('edit.title')} value={c.title} onSave={(v) => api.setTitle(c.id, v)} />}
        <EditableField
          label={nt('edit.topic')}
          value={c.topic ?? ''}
          placeholder={nt('edit.topicPlaceholder')}
          multiline
          onSave={(v) => api.setTopic(c.id, v || null)}
        />
        <div className="nx-rows">
          <ToggleRow label={nt('edit.pinned')} checked={!!c.pinned} onChange={(v) => api.togglePin(c.id, v)} />
          <ToggleRow
            label={nt('edit.muted')}
            hint={muted && c.mutedUntil ? nt('edit.mutedUntil', { when: new Date(c.mutedUntil).toLocaleString() }) : undefined}
            checked={muted}
            onChange={(v) => api.setMute(c.id, v, null)}
          />
          {c.projectName && (
            <div className="nx-row"><span className="nx-row__text"><span>{nt('edit.project')}</span></span><span className="nx-chip">{c.projectName}</span></div>
          )}
        </div>
      </section>
      {admin && agents.length > 0 && <AgentGroup agents={agents} />}
      {admin && <AgentEditDialog />}
      <div className="nx-edit__actions">
        {c.kind !== 'email' && (
          <button
            type="button"
            className="nx-btn nx-btn--outline nx-btn--block"
            disabled={convening}
            onClick={async () => {
              setConvening(true)
              try {
                await api.startConvene(c.id, c.title)
                haptic('success')
                navigate(href({ section: 'convene' }))
              } catch (e) {
                haptic('error')
                console.warn('[next] convene failed', e)
              } finally {
                setConvening(false)
              }
            }}
          >
            {convening ? <Spinner /> : <IConvene />}
            {nt('edit.convene')}
          </button>
        )}
        {c.kind === 'group' && (
          <button
            type="button"
            className="nx-btn nx-btn--danger nx-btn--block"
            onClick={async () => {
              if (!window.confirm(nt('chats.leaveConfirm', { name: c.title }))) return
              await api.leaveConversation(c.id)
              await useConversations.getState().reload()
              navigate(href({ section: 'chats' }), { replace: true })
            }}
          >
            <IExit />
            {nt('edit.leave')}
          </button>
        )}
      </div>
    </div>
  )
}

export function EditDialog({ c, agents }: { c: Conversation; agents: Participant[] }) {
  const nt = useNT()
  const open = useRoute().search.has(EDIT_PARAM)
  // A second goBack before the first lands (a double click on the scrim)
  // would also leave the room.
  const closing = useRef(false)
  useEffect(() => { closing.current = false }, [open])
  const close = useCallback(() => {
    const r = getRoute()
    // Esc reaches this dialog too while the agent editor is open over it; the
    // editor closes alone.
    if (closing.current || !r.search.has(EDIT_PARAM) || r.search.has(AGENT_EDIT_PARAM)) return
    closing.current = true
    goBack(withRoute(r, { params: { [EDIT_PARAM]: null } }))
  }, [])
  return (
    <Dialog open={open} onClose={close} title={nt('chat.edit', { room: c.title })}>
      <RoomEdit c={c} agents={agents} />
    </Dialog>
  )
}
