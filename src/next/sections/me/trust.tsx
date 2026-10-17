/** Agent trust: how freely each agent may act, and what agents may do at all. */
import { memo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useParticipants } from '@/stores/participants'
import { usePrefs } from '@/stores/preferences'
import type { Participant } from '@/types'
import { useNT } from '../../i18n'
import { href, linkClick } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { Spinner } from '../../ui/primitives'
import { Block, ErrorLine, errorText, LongList, PrefRow, saveAutonomy, usePrefsLoad } from './parts'

/** What an agent without a stored threshold acts with (same as the classic screen). */
const DEFAULT_THRESHOLD = 0.6

const AutonomyRow = memo(function AutonomyRow({ agent, sep, disabled }: { agent: Participant; sep: boolean; disabled: boolean }) {
  const nt = useNT()
  const record = usePrefs((s) => s.autonomy[agent.id])
  const saved = record?.threshold ?? DEFAULT_THRESHOLD
  // The slider moves freely; the value is saved once, when it is let go.
  const [draft, setDraft] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = draft ?? saved
  const commit = async () => {
    if (draft === null) return
    setDraft(null)
    if (draft === saved) return
    setBusy(true)
    setError(null)
    try {
      await saveAutonomy(agent.id, draft)
    } catch (e) {
      setError(nt('me.saveFailed', { error: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }
  const facts = [
    agent.role,
    record ? nt('me.trust.record', { pulled: record.pulled, led: record.led, noise: record.dissolved }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="nx-me-agent" data-sep={sep || undefined}>
      <div className="nx-me-agent__top">
        <a className="nx-me-agent__who" href={href({ section: 'agents', id: agent.id })} onClick={linkClick}>
          <Avatar p={agent} size={32} presence />
          <span className="nx-me-row__text">
            <span className="nx-me-row__label">{agent.name}</span>
            {facts && <span className="nx-me-row__hint">{facts}</span>}
          </span>
        </a>
        {busy && <Spinner />}
        <output className="nx-me-agent__value nx-mono">{value.toFixed(2)}</output>
      </div>
      <input
        type="range"
        className="nx-me-range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        disabled={disabled}
        aria-label={nt('me.trust.threshold', { name: agent.name })}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={() => void commit()}
        onBlur={() => void commit()}
      />
      {error && <p className="nx-me-row__error" role="alert">{error}</p>}
    </div>
  )
})

export function TrustPage() {
  const nt = useNT()
  const prefs = usePrefsLoad()
  const agents = useParticipants(useShallow((s) =>
    Object.values(s.byId)
      .filter((p) => p.kind === 'agent' && !p.departedAt)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ))
  return (
    <>
      <p className="nx-me-intro">{nt('me.trust.intro')}</p>
      {prefs.failed && <ErrorLine message={nt('me.prefsFailed')} onRetry={prefs.retry} />}
      <Block title={nt('me.trust.autonomy')}>
        <div className="nx-me-card">
          {agents.length === 0 ? (
            <p className="nx-me-empty">{nt('me.trust.none')}</p>
          ) : (
            <LongList items={agents} itemKey={(a) => a.id}>
              {(a, i) => <AutonomyRow agent={a} sep={i > 0} disabled={!prefs.loaded} />}
            </LongList>
          )}
        </div>
      </Block>
      <Block title={nt('me.trust.permissions')}>
        <div className="nx-me-card">
          <PrefRow k="priv.allow_silent_whispers" def label={nt('me.trust.silentWhispers')} hint={nt('me.trust.silentWhispersHint')} />
          <PrefRow k="priv.allow_new_tools" def label={nt('me.trust.newTools')} hint={nt('me.trust.newToolsHint')} />
          <PrefRow k="priv.allow_human_invites" def={false} label={nt('me.trust.humanInvites')} hint={nt('me.trust.humanInvitesHint')} />
        </div>
      </Block>
    </>
  )
}
