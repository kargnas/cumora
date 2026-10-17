/** Profile, Account (sign out, delete account) and About. */
import { useEffect, useState } from 'react'
import { api, getServerOrigin } from '@/api/client'
import { teardownPushNotifications } from '@/lib/push'
import type { AppUpdateInfo } from '@/lib/runtime'
import { useAuth } from '@/stores/auth'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import type { Route } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { Dialog, Spinner } from '../../ui/primitives'
import { IExternal } from '../../ui/icons'
import { Block, closeSheet, ErrorLine, errorText, openSheet, Row, SkeletonRows, useMePerson } from './parts'

/** Brand names stay as written in every locale. */
const PROVIDER_LABEL: Record<string, string> = { google: 'Google', github: 'GitHub', gitlab: 'GitLab', apple: 'Apple' }

const DISCORD_URL = 'https://discord.gg/hzfcsB6vMr'

export function ProfilePage() {
  const nt = useNT()
  const user = useAuth((s) => s.user)
  const me = useMePerson()
  if (!user || !me) return null
  const providers = user.providers ?? []
  return (
    <>
      <div className="nx-me-identity">
        <Avatar p={me} size={64} />
        <span className="nx-me-identity__text">
          <b>{user.name}</b>
          <span>{user.email}</span>
        </span>
      </div>
      <div className="nx-me-card">
        <Row label={nt('me.profile.signIn')} hint={nt('me.profile.signInHint')}>
          <span className="nx-me-chips">
            {providers.length > 0
              ? providers.map((p) => <span key={p} className="nx-chip">{PROVIDER_LABEL[p] ?? p}</span>)
              : <span className="nx-me-row__value">{nt('me.profile.noProviders')}</span>}
          </span>
        </Row>
      </div>
    </>
  )
}

export function AccountPage({ route }: { route: Route }) {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  // Empty origin = the API is this page's own origin (or the dev proxy).
  const server = getServerOrigin() || location.host
  const signOut = async () => {
    setBusy(true)
    // Revoke while the token is still attached: clearing first would send
    // the logout unauthenticated. A hung network must not keep anyone in.
    await Promise.race([
      Promise.allSettled([
        teardownPushNotifications(),
        api.authLogout().catch((e) => console.warn('[me] sign-out request failed', e)),
      ]),
      new Promise((resolve) => window.setTimeout(resolve, 4000)),
    ])
    useAuth.getState().clear()
    location.reload()
  }
  return (
    <>
      <div className="nx-me-card">
        <Row label={nt('me.account.signedIn', { server })} hint={nt('me.account.signOutHint')}>
          <button type="button" className="nx-btn nx-btn--outline" disabled={busy} onClick={() => void signOut()}>
            {busy && <Spinner />}
            {nt('me.account.signOut')}
          </button>
        </Row>
        <Row label={nt('me.account.delete')} hint={nt('me.account.deleteHint')}>
          <button type="button" className="nx-btn nx-btn--danger" onClick={() => openSheet(route, 'delete-account')}>
            {nt('me.account.deleteOpen')}
          </button>
        </Row>
      </div>
      <Dialog
        open={route.search.get('sheet') === 'delete-account'}
        onClose={() => closeSheet('delete-account')}
        title={nt('me.account.deleteTitle')}
      >
        <DeleteAccountForm />
      </Dialog>
    </>
  )
}

function DeleteAccountForm() {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteAccount()
    } catch (e) {
      haptic('error')
      setError(errorText(e))
      setBusy(false)
      return
    }
    haptic('success')
    // The server has ended every session already; push cleanup is best effort.
    useAuth.getState().clear()
    await teardownPushNotifications()
    location.reload()
  }
  return (
    <div className="nx-me-form">
      <p className="nx-me-text">{nt('me.account.deleteBody')}</p>
      {error && <ErrorLine message={error} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" disabled={busy} onClick={() => closeSheet('delete-account')}>{nt('me.cancel')}</button>
        <button type="button" className="nx-btn nx-me-destroy" disabled={busy} onClick={() => void remove()}>
          {busy && <Spinner />}
          {nt('me.account.deleteConfirm')}
        </button>
      </div>
    </div>
  )
}

/** Only the desktop app has a version and an updater; the web build has neither. */
function useAppInfo(): { bridge: boolean; info: AppUpdateInfo | null } {
  const bridge = window.cumora?.update
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  useEffect(() => {
    if (!bridge) return
    let live = true
    bridge.getAppInfo().then(
      (i) => { if (live) setInfo(i) },
      (e) => console.warn('[me] app info unavailable', e),
    )
    return () => { live = false }
  }, [bridge])
  return { bridge: Boolean(bridge), info }
}

export function AboutPage() {
  const nt = useNT()
  const { bridge, info } = useAppInfo()
  return (
    <>
      {bridge && (
        <Block title={nt('me.about.app')}>
          {info ? (
            <div className="nx-me-card">
              <Row
                label={nt('me.about.version', { version: info.version })}
                hint={nt(info.autoUpdateSupported ? 'me.about.autoUpdate' : 'me.about.noAutoUpdate')}
              >
                {/* App.tsx owns the updater dialog and listens for this event. */}
                <button type="button" className="nx-btn nx-btn--outline" onClick={() => window.dispatchEvent(new CustomEvent('cumora:open-updater'))}>
                  {nt('me.about.check')}
                </button>
              </Row>
            </div>
          ) : <SkeletonRows n={1} />}
        </Block>
      )}
      <Block title={nt('me.about.community')}>
        <div className="nx-me-card">
          <Row label={nt('me.about.discord')} hint={nt('me.about.discordHint')}>
            <a className="nx-btn nx-btn--outline" href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
              {nt('me.about.join')}
              <IExternal />
            </a>
          </Row>
        </div>
      </Block>
    </>
  )
}
