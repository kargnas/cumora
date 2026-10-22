/**
 * First screen on a device that has not picked a design: App.tsx shows it at
 * `/` while `localStorage['cumora.ui']` is unset, before sign-in, on the web
 * and in the native apps alike.
 */
import { WindowDragStrip } from '@/components/WindowDragStrip'
import { useNT } from '../i18n'
import { useNativeChrome, useNextDocument } from '../document'
import '../styles/shell.css'

function pick(ui: 'next' | 'classic'): void {
  try { localStorage.setItem('cumora.ui', ui) } catch { /* storage disabled */ }
  // App.tsx reads the choice once, at boot, and moves `/` to `/next` itself,
  // so reloading `/` routes the pick in the native apps too.
  location.reload()
}

export default function DesignChoice() {
  useNextDocument()
  useNativeChrome()
  const nt = useNT()
  return (
    <main className="nx-signin">
      <WindowDragStrip />
      <div className="nx-signin__card">
        <img className="nx-signin__mark" src="/icon-192.png" alt="" width={56} height={56} />
        <h1>{nt('design.title')}</h1>
        <p className="nx-signin__sub">{nt('design.subtitle')}</p>
        <div className="nx-signin__providers">
          <button type="button" className="nx-design__option" onClick={() => pick('next')}>
            {nt('design.modern')}
            <span>{nt('design.modernSub')}</span>
          </button>
          <button type="button" className="nx-design__option" onClick={() => pick('classic')}>
            {nt('design.classic')}
            <span>{nt('design.classicSub')}</span>
          </button>
        </div>
      </div>
    </main>
  )
}
