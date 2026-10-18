/**
 * Workspace: switch or create workspaces; owners and admins also manage
 * members, roles and invitations (the server allows nobody else to list
 * them), and the owner can delete the workspace.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ws, type ApiInvitation, type ApiInvitationWithToken, type ApiWorkspaceMember } from '@/api/client'
import { copyText } from '@/lib/clipboard'
import { useLocale } from '@/lib/i18n'
import { useAuth, type AuthCompany } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import type { Route } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { Dialog, IconButton, Segmented, Spinner } from '../../ui/primitives'
import { ICheck, IChevronDown, IPlus, ITrash } from '../../ui/icons'
import {
  Block, Choices, closeSheet, CopyCode, count, dropSheet, ErrorLine, errorText, LongList, openSheet, personOf, relative,
  roleKey, Row, setParams, SkeletonRows, SwitchRow,
} from './parts'

type MutableRole = 'member' | 'admin'

const MemberRow = memo(function MemberRow({ m, company, meId, sep, busy, onRole, onRemove }: {
  m: ApiWorkspaceMember
  company: AuthCompany
  meId: string | undefined
  sep: boolean
  busy: boolean
  onRole: (m: ApiWorkspaceMember, role: MutableRole) => void
  onRemove: (m: ApiWorkspaceMember) => void
}) {
  const nt = useNT()
  const participant = useParticipants((s) => s.byId[m.id])
  const person = participant ?? personOf(m.id, m.name, m.avatarUrl)
  // Ownership never changes here; admins may only remove plain members.
  const canChangeRole = company.role === 'owner' && m.role !== 'owner'
  const canRemove = m.id !== meId && m.role !== 'owner'
    && (company.role === 'owner' || (company.role === 'admin' && m.role === 'member'))
  return (
    <div className="nx-me-row" data-sep={sep || undefined}>
      <Avatar p={person} size={32} />
      <span className="nx-me-row__text">
        <span className="nx-me-row__label">
          {m.name}
          {m.id === meId && <span className="nx-me-you">{nt('me.workspace.you')}</span>}
        </span>
        <span className="nx-me-row__hint">{m.email}</span>
      </span>
      {busy && <Spinner />}
      {canChangeRole ? (
        <select
          className="nx-me-select"
          value={m.role}
          disabled={busy}
          aria-label={nt('me.workspace.roleOf', { name: m.name })}
          onChange={(e) => onRole(m, e.target.value as MutableRole)}
        >
          <option value="member">{nt('me.role.member')}</option>
          <option value="admin">{nt('me.role.admin')}</option>
        </select>
      ) : (
        <span className="nx-chip">{nt(roleKey(m.role))}</span>
      )}
      {canRemove && (
        <IconButton small label={nt('me.workspace.removeMember', { name: m.name })} disabled={busy} onClick={() => onRemove(m)}>
          <ITrash />
        </IconButton>
      )}
    </div>
  )
})

function Members({ company }: { company: AuthCompany }) {
  const nt = useNT()
  const meId = useAuth((s) => s.user?.id)
  const [members, setMembers] = useState<ApiWorkspaceMember[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Only the newest load may write: an older reply must not undo a newer one.
  const generation = useRef(0)
  const load = useCallback(async () => {
    const g = ++generation.current
    setLoadError(null)
    try {
      const rows = await api.listWorkspaceMembers(company.id)
      if (g === generation.current) setMembers(rows)
    } catch (e) {
      if (g === generation.current) setLoadError(errorText(e))
    }
  }, [company.id])
  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])
  // Changes made by other admins arrive over the socket.
  useEffect(() => ws.on((e) => {
    if (e.type === 'workspace.membership' && e.companyId === company.id) void load()
  }), [company.id, load])

  const onRole = useCallback(async (m: ApiWorkspaceMember, role: MutableRole) => {
    if (m.role === role) return
    setBusyId(m.id)
    setActionError(null)
    const put = (r: ApiWorkspaceMember['role']) => setMembers((cur) => cur && cur.map((x) => (x.id === m.id ? { ...x, role: r } : x)))
    put(role)
    try {
      const result = await api.updateWorkspaceMemberRole(company.id, m.id, role)
      setMembers((cur) => cur && cur.map((x) => (x.id === m.id ? result.member : x)))
    } catch (e) {
      put(m.role)
      setActionError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }, [company.id])

  const onRemove = useCallback(async (m: ApiWorkspaceMember) => {
    if (!window.confirm(nt('me.workspace.removeConfirm', { name: m.name }))) return
    setBusyId(m.id)
    setActionError(null)
    try {
      await api.removeWorkspaceMember(company.id, m.id)
      haptic('success')
      setMembers((cur) => cur && cur.filter((x) => x.id !== m.id))
    } catch (e) {
      haptic('error')
      setActionError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }, [company.id, nt])

  return (
    <Block title={nt('me.workspace.members')} hint={nt('me.workspace.membersHint')}>
      {loadError && <ErrorLine message={loadError} onRetry={() => void load()} />}
      {actionError && <ErrorLine message={actionError} />}
      {members === null ? (
        !loadError && <SkeletonRows n={3} />
      ) : (
        <div className="nx-me-card">
          <LongList items={members} itemKey={(m) => m.id}>
            {(m, i) => (
              <MemberRow
                m={m}
                company={company}
                meId={meId}
                sep={i > 0}
                busy={busyId === m.id}
                onRole={onRole}
                onRemove={onRemove}
              />
            )}
          </LongList>
        </div>
      )}
    </Block>
  )
}

/** The raw invite link exists only in the create response (the server keeps
 *  a hash), so a listed invite can hand out only its reference. */
function CopyRef({ id }: { id: string }) {
  const nt = useNT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className="nx-btn nx-btn--sm"
      title={nt('me.invite.copyRefHint')}
      onClick={() => {
        copyText(id).then(
          () => setCopied(true),
          (e) => { haptic('error'); console.warn('[me] copy failed', e) },
        )
      }}
    >
      {copied && <ICheck />}
      {nt(copied ? 'me.copied' : 'me.invite.copyRef')}
    </button>
  )
}

function inviteStatus(inv: ApiInvitation) {
  if (inv.status === 'active') return inv.email ? 'awaiting' : 'shareable'
  return inv.status === 'consumed' ? 'used' : inv.status
}

const InviteRow = memo(function InviteRow({ inv, sep, onRevoke }: {
  inv: ApiInvitation
  sep: boolean
  onRevoke?: (inv: ApiInvitation) => void
}) {
  const nt = useNT()
  const locale = useLocale()
  const meta = [
    inv.email ? null : nt('me.invite.used', { used: inv.useCount, max: inv.maxUses }),
    inv.status === 'active' ? nt('me.invite.expires', { when: relative(inv.expiresAt, locale) }) : null,
    inv.status === 'consumed' && inv.lastAcceptedAt ? nt('me.invite.accepted', { when: relative(inv.lastAcceptedAt, locale) }) : null,
    inv.note,
  ].filter(Boolean).join(' · ')
  return (
    <div className="nx-me-row" data-sep={sep || undefined} data-dim={inv.status !== 'active' || undefined}>
      <span className="nx-me-row__text">
        <span className="nx-me-row__label nx-me-row__line">
          <span className="nx-me-row__name">{inv.email ?? nt('me.invite.shareable')}</span>
          <span className="nx-chip">{nt(`me.invite.status.${inviteStatus(inv)}`)}</span>
          <span className="nx-chip">{nt(roleKey(inv.role))}</span>
        </span>
        {meta && <span className="nx-me-row__hint">{meta}</span>}
      </span>
      {onRevoke && (
        <span className="nx-me-row__actions">
          <CopyRef id={inv.id} />
          <button type="button" className="nx-btn nx-btn--sm nx-btn--danger" onClick={() => onRevoke(inv)}>{nt('me.invite.revoke')}</button>
        </span>
      )}
    </div>
  )
})

function CreatedInvite({ invite, onDismiss }: { invite: ApiInvitationWithToken; onDismiss: () => void }) {
  const nt = useNT()
  const delivery = invite.emailDelivery
  const sent = Boolean(delivery?.attempted && delivery.ok)
  return (
    <div className="nx-me-created" role="status">
      <b><ICheck />{nt(sent ? 'me.invite.sent' : 'me.invite.ready')}</b>
      <p className="nx-me-text">
        {invite.email
          ? nt(sent ? 'me.invite.deliveredTo' : 'me.invite.lockedTo', { email: invite.email })
          : nt('me.invite.anyone', { role: nt(roleKey(invite.role)) })}
      </p>
      {delivery?.attempted && !delivery.ok && (
        <ErrorLine message={nt('me.invite.sendFailed', { error: delivery.error ?? nt('me.invite.unknownError') })} />
      )}
      {delivery?.skipped === 'no_email_config' && <p className="nx-me-note">{nt('me.invite.noEmailConfig')}</p>}
      <CopyCode value={invite.url} />
      <div className="nx-me-actions">
        <button type="button" className="nx-btn nx-btn--sm" onClick={onDismiss}>{nt('me.invite.dismiss')}</button>
      </div>
    </div>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function InviteForm({ company, route, onCreated }: { company: AuthCompany; route: Route; onCreated: () => void }) {
  const nt = useNT()
  const via = route.search.get('via') === 'email' ? 'email' : 'link'
  const emailCapable = useAuth((s) => s.serverCapabilities?.invitationEmail === true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MutableRole>('member')
  const [note, setNote] = useState('')
  const [sendEmail, setSendEmail] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<ApiInvitationWithToken | null>(null)
  // Switching between link and email starts a fresh invite.
  useEffect(() => {
    setCreated(null)
    setError(null)
  }, [via])

  const submit = async () => {
    setError(null)
    setCreated(null)
    const address = email.trim()
    const invalid = via !== 'email' ? null : !address ? 'me.invite.needEmail' : !EMAIL_RE.test(address) ? 'me.invite.badEmail' : null
    if (invalid) {
      setError(nt(invalid))
      return
    }
    setBusy(true)
    try {
      const inv = await api.createInvitation(company.id, via === 'email'
        ? { email: address, role, note: note.trim() || null, sendEmail: emailCapable && sendEmail }
        : { multiUse: true, role, note: note.trim() || null })
      haptic('success')
      setCreated(inv)
      setEmail('')
      setNote('')
      onCreated()
    } catch (e) {
      haptic('error')
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="nx-me-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <p className="nx-me-text">{nt('me.invite.intro')}</p>
      <Segmented
        label={nt('me.invite.how')}
        value={via}
        onChange={(k) => setParams(route, { via: k === 'email' ? 'email' : null })}
        items={[{ key: 'link', label: nt('me.invite.link') }, { key: 'email', label: nt('me.invite.email') }]}
      />
      {via === 'email' ? (
        <>
          <label className="nx-field">
            <span className="nx-field__label">{nt('me.invite.emailLabel')}</span>
            <input
              type="email"
              className="nx-input"
              value={email}
              autoComplete="off"
              placeholder={nt('me.invite.emailPh')}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="nx-me-note">{nt('me.invite.emailHint')}</span>
          </label>
          {emailCapable && (
            <div className="nx-me-card">
              <SwitchRow label={nt('me.invite.sendEmail')} hint={nt('me.invite.sendEmailHint')} checked={sendEmail} onChange={setSendEmail} />
            </div>
          )}
        </>
      ) : (
        <p className="nx-me-note">{nt('me.invite.linkHint')}</p>
      )}
      {/* Admins may invite members only; the server enforces it too. */}
      {company.role === 'owner' && (
        <div className="nx-field">
          <span className="nx-field__label">{nt('me.invite.role')}</span>
          <Segmented
            label={nt('me.invite.role')}
            value={role}
            onChange={setRole}
            items={[{ key: 'member', label: nt('me.role.member') }, { key: 'admin', label: nt('me.role.admin') }]}
          />
        </div>
      )}
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.invite.note')}</span>
        <input className="nx-input" value={note} maxLength={120} placeholder={nt('me.invite.notePh')} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <ErrorLine message={error} />}
      {created && <CreatedInvite invite={created} onDismiss={() => setCreated(null)} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" onClick={() => closeSheet('invite')}>{nt('me.done')}</button>
        <button type="submit" className="nx-btn nx-btn--primary" disabled={busy}>
          {busy && <Spinner />}
          {nt(via === 'email' ? 'me.invite.createEmail' : 'me.invite.createLink')}
        </button>
      </div>
    </form>
  )
}

function Invitations({ company, route }: { company: AuthCompany; route: Route }) {
  const nt = useNT()
  const [list, setList] = useState<ApiInvitation[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setList(await api.listInvitations(company.id))
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [company.id])
  useEffect(() => { void load() }, [load])

  const pending = useMemo(() => (list ?? []).filter((i) => i.status === 'active'), [list])
  const past = useMemo(() => (list ?? []).filter((i) => i.status !== 'active'), [list])
  const showPast = route.search.get('past') === '1'

  const revoke = useCallback(async (inv: ApiInvitation) => {
    if (!window.confirm(nt('me.invite.revokeConfirm', { name: inv.email ?? nt('me.invite.shareable') }))) return
    setActionError(null)
    try {
      await api.revokeInvitation(company.id, inv.id)
      await load()
    } catch (e) {
      setActionError(errorText(e))
    }
  }, [company.id, load, nt])

  return (
    <Block title={nt('me.invite.pending')} hint={nt('me.invite.expiry')}>
      <div className="nx-me-actions nx-me-actions--start">
        <button type="button" className="nx-btn nx-btn--primary" onClick={() => openSheet(route, 'invite')}>
          <IPlus />
          {nt('me.invite.open')}
        </button>
      </div>
      {loadError && <ErrorLine message={loadError} onRetry={() => void load()} />}
      {actionError && <ErrorLine message={actionError} />}
      {list === null ? (
        !loadError && <SkeletonRows n={2} />
      ) : pending.length === 0 ? (
        <div className="nx-me-card"><p className="nx-me-empty">{nt('me.invite.none')}</p></div>
      ) : (
        <div className="nx-me-card">
          <LongList items={pending} itemKey={(i) => i.id}>
            {(inv, i) => <InviteRow inv={inv} sep={i > 0} onRevoke={revoke} />}
          </LongList>
        </div>
      )}
      {past.length > 0 && (
        <>
          <button type="button" className="nx-me-disclose" aria-expanded={showPast} onClick={() => setParams(route, { past: showPast ? null : '1' })}>
            <IChevronDown />
            {count(nt, past.length, 'me.invite.pastOne', 'me.invite.past')}
          </button>
          {showPast && (
            <div className="nx-me-card">
              <LongList items={past} itemKey={(i) => i.id}>
                {(inv, i) => <InviteRow inv={inv} sep={i > 0} />}
              </LongList>
            </div>
          )}
        </>
      )}
      <Dialog
        open={route.search.get('sheet') === 'invite'}
        onClose={() => closeSheet('invite')}
        title={nt('me.invite.title', { name: company.name })}
      >
        <InviteForm company={company} route={route} onCreated={() => void load()} />
      </Dialog>
    </Block>
  )
}

function NewWorkspaceForm() {
  const nt = useNT()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createCompany(trimmed)
      haptic('success')
      // Joining switches workspace, which remounts the app at this URL.
      dropSheet()
      useAuth.getState().addCompany({ id: created.id, name: created.name, slug: created.slug, role: created.role })
    } catch (e) {
      haptic('error')
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <form className="nx-me-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.workspace.name')}</span>
        <input className="nx-input" value={name} disabled={busy} placeholder={nt('me.workspace.namePh')} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <ErrorLine message={error} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" onClick={() => closeSheet('new-workspace')}>{nt('me.cancel')}</button>
        <button type="submit" className="nx-btn nx-btn--primary" disabled={busy || !name.trim()}>
          {busy && <Spinner />}
          {nt('me.workspace.create')}
        </button>
      </div>
    </form>
  )
}

function DeleteWorkspaceForm({ company }: { company: AuthCompany }) {
  const nt = useNT()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (typed !== company.name) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.deleteCompany(company.id, typed)
      haptic('success')
      dropSheet()
      if (useAuth.getState().removeCompany(company.id, result.nextCompanyId)) ws.reconnect()
    } catch (e) {
      haptic('error')
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <form className="nx-me-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <p className="nx-me-text">{nt('me.workspace.deleteHint')}</p>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.workspace.typeName', { name: company.name })}</span>
        <input className="nx-input" value={typed} disabled={busy} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </label>
      {error && <ErrorLine message={error} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" disabled={busy} onClick={() => closeSheet('delete-workspace')}>{nt('me.cancel')}</button>
        <button type="submit" className="nx-btn nx-me-destroy" disabled={busy || typed !== company.name}>
          {busy && <Spinner />}
          {nt('me.workspace.delete')}
        </button>
      </div>
    </form>
  )
}

export function WorkspacePage({ route }: { route: Route }) {
  const nt = useNT()
  const companies = useAuth((s) => s.companies)
  const activeId = useAuth((s) => s.activeCompanyId)
  const setActive = useAuth((s) => s.setActiveCompany)
  const active = companies.find((c) => c.id === activeId) ?? null
  const admin = active?.role === 'owner' || active?.role === 'admin'
  const sheet = route.search.get('sheet')
  return (
    <>
      <Block title={nt('me.workspace.switch')} hint={nt('me.workspace.switchHint')}>
        <Choices
          label={nt('me.workspace.switch')}
          value={activeId ?? ''}
          onChange={(id) => { if (id !== activeId) setActive(id) }}
          items={companies.map((c) => ({ key: c.id, label: c.name, hint: nt(roleKey(c.role)) }))}
        />
        <div className="nx-me-actions nx-me-actions--start">
          <button type="button" className="nx-btn nx-btn--outline" onClick={() => openSheet(route, 'new-workspace')}>
            <IPlus />
            {nt('me.workspace.new')}
          </button>
        </div>
      </Block>
      {active && admin && <Members key={`m-${active.id}`} company={active} />}
      {active && admin && <Invitations key={`i-${active.id}`} company={active} route={route} />}
      {active?.role === 'owner' && (
        <Block title={nt('me.workspace.delete')}>
          <div className="nx-me-card">
            <Row
              label={nt('me.workspace.deleteLabel', { name: active.name })}
              hint={nt(companies.length > 1 ? 'me.workspace.deleteHint' : 'me.workspace.onlyOne')}
            >
              <button
                type="button"
                className="nx-btn nx-btn--danger"
                disabled={companies.length <= 1}
                onClick={() => openSheet(route, 'delete-workspace')}
              >
                {nt('me.workspace.deleteOpen')}
              </button>
            </Row>
          </div>
        </Block>
      )}
      <Dialog open={sheet === 'new-workspace'} onClose={() => closeSheet('new-workspace')} title={nt('me.workspace.new')}>
        <NewWorkspaceForm />
      </Dialog>
      {active && (
        <Dialog
          open={sheet === 'delete-workspace' && active.role === 'owner' && companies.length > 1}
          onClose={() => closeSheet('delete-workspace')}
          title={nt('me.workspace.deleteTitle', { name: active.name })}
        >
          <DeleteWorkspaceForm company={active} />
        </Dialog>
      )}
    </>
  )
}
