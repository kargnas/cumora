import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { isMuted, useConversations } from '@/stores/conversations'
import type { Conversation } from '@/types'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { href, navigate } from '../router'
import { Spinner, Switch } from '../ui/primitives'
import { IConvene, IExit } from '../ui/icons'

/** A field that saves on blur/Enter and shows its own pending state, so an
 *  edit never blocks the rest of the panel. */
function EditableField({ label, value, multiline, placeholder, onSave }: {
  label: string
  value: string
  multiline?: boolean
  placeholder?: string
  onSave: (v: string) => Promise<unknown>
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(value), [value])
  const commit = async () => {
    if (draft.trim() === value.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave(draft.trim())
      await useConversations.getState().reload()
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
      <span className="nx-field__label">{label}{saving && <Spinner />}</span>
      {multiline
        ? <textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} />
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

export function DetailsTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const [convening, setConvening] = useState(false)
  const muted = isMuted(c)
  const canRename = c.kind === 'group'
  return (
    <div className="nx-details">
      {canRename && <EditableField label={nt('details.title')} value={c.title} onSave={(v) => api.setTitle(c.id, v)} />}
      <EditableField
        label={nt('details.topic')}
        value={c.topic ?? ''}
        placeholder={nt('details.topicPlaceholder')}
        multiline
        onSave={(v) => api.setTopic(c.id, v || null)}
      />
      <div className="nx-rows">
        <ToggleRow label={nt('details.pinned')} checked={!!c.pinned} onChange={(v) => api.togglePin(c.id, v)} />
        <ToggleRow
          label={nt('details.muted')}
          hint={muted && c.mutedUntil ? nt('details.mutedUntil', { when: new Date(c.mutedUntil).toLocaleString() }) : undefined}
          checked={muted}
          onChange={(v) => api.setMute(c.id, v, null)}
        />
      </div>
      {c.projectName && (
        <div className="nx-rows">
          <div className="nx-row"><span className="nx-row__text"><span>{nt('details.project')}</span></span><span className="nx-chip">{c.projectName}</span></div>
        </div>
      )}
      <div className="nx-details__actions">
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
            {nt('details.convene')}
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
            {nt('details.leave')}
          </button>
        )}
      </div>
    </div>
  )
}
