/**
 * First screen on a device that has not picked a design: App.tsx shows it at
 * `/` while the choice (`designPref.ts`) is unset, before sign-in, on the web
 * and in the native apps alike (the public `app.*` host shows its WebShell
 * instead).
 */
import { WindowDragStrip } from '@/components/WindowDragStrip'
import { useAppearanceStore } from '@/lib/theme'
import { writeDesignPref } from '../designPref'
import { useNT } from '../i18n'
import { useNativeChrome, useNextDocument } from '../document'
import '../styles/shell.css'

export default function DesignChoice({ onUnsavedClassic }: { onUnsavedClassic: () => void }) {
  useNextDocument()
  useNativeChrome()
  const nt = useNT()
  const pickModern = () => {
    writeDesignPref('next')
    // `/next` boots the redesign whether or not storage kept the pick.
    location.replace(`/next${location.search}${location.hash}`)
  }
  const pickClassic = () => {
    // A reload boots the classic shell with its own chrome colors. Without a
    // stored pick it would ask again, so then leave the choice without one,
    // and once this screen is gone let the classic theme repaint the browser
    // and status bar colors the redesign painted.
    if (writeDesignPref('classic')) location.reload()
    else {
      onUnsavedClassic()
      window.setTimeout(() => {
        const appearance = useAppearanceStore.getState()
        appearance.setAppearance(appearance.appearance)
      })
    }
  }
  return (
    <main className="nx-signin">
      <WindowDragStrip />
      <div className="nx-signin__card">
        <img className="nx-signin__mark" src="/icon-192.png" alt="" width={56} height={56} />
        <h1>{nt('design.title')}</h1>
        <p className="nx-signin__sub">{nt('design.subtitle')}</p>
        <div className="nx-signin__providers">
          <button type="button" className="nx-signin__provider nx-design__option" onClick={pickModern}>
            {nt('design.modern')}
            <span>{nt('design.modernSub')}</span>
          </button>
          <button type="button" className="nx-signin__provider nx-design__option" onClick={pickClassic}>
            {nt('design.classic')}
            <span>{nt('design.classicSub')}</span>
          </button>
        </div>
      </div>
    </main>
  )
}
