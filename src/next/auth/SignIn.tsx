/**
 * Sign-in screen of the redesign. AuthGate shows it in place of the classic
 * AuthScreen when the app runs in Next mode (the native apps by default).
 * The provider flows (browser redirect, Electron loopback + nonce, native
 * OAuth tab, Sign in with Apple) are the classic ones from useSignIn.
 */
import { useState } from 'react'
import { AppleMark, GitHubMark, GitLabMark, GoogleMark, ServerSwitch, useSignIn } from '@/components/AuthScreen'
import { WindowDragStrip } from '@/components/WindowDragStrip'
import { isCapacitorIOS } from '@/lib/runtime'
import { nativePlatform } from '@/lib/native'
import { useNT } from '../i18n'
import { useNativeChrome, useNextDocument } from '../document'
import { Spinner } from '../ui/primitives'
import '../styles/shell.css'

type Provider = 'google' | 'github' | 'gitlab' | 'apple'

export default function SignIn() {
  useNextDocument()
  useNativeChrome()
  const nt = useNT()
  const { busy, err, gitlabEnabled, go, goApple } = useSignIn()
  const [picker, setPicker] = useState(false)

  const button = (provider: Provider, label: string, mark: JSX.Element, onClick: () => void) => (
    <button
      type="button"
      className="nx-signin__provider"
      data-provider={provider}
      disabled={busy !== null}
      aria-busy={busy === provider || undefined}
      onClick={onClick}
    >
      {busy === provider ? <Spinner /> : mark}
      <span>{busy === provider ? nt(provider === 'apple' ? 'auth.signingIn' : 'auth.redirecting') : label}</span>
    </button>
  )

  return (
    <main className="nx-signin">
      <WindowDragStrip />
      <div className="nx-signin__card">
        <img className="nx-signin__mark" src="/icon-192.png" alt="" width={56} height={56} />
        <h1>{nt('auth.title')}</h1>
        <p className="nx-signin__sub">{nt('auth.subtitle')}</p>
        <div className="nx-signin__providers">
          {isCapacitorIOS && nativePlatform() === 'ios' && button('apple', nt('auth.apple'), <AppleMark />, () => void goApple())}
          {button('google', nt('auth.google'), <GoogleMark />, () => go('google'))}
          {button('github', nt('auth.github'), <GitHubMark />, () => go('github'))}
          {gitlabEnabled && button('gitlab', nt('auth.gitlab'), <GitLabMark />, () => go('gitlab'))}
        </div>
        {err && <p className="nx-signin__error" role="alert">{err}</p>}
        <p className="nx-signin__note">{nt('auth.note')}</p>
        <ServerSwitch open={picker} onToggle={() => setPicker((v) => !v)} />
      </div>
    </main>
  )
}
