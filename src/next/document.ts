/**
 * Page-level setup shared by every redesign entry point (the app shell and
 * the sign-in screen): the `html.nx` token scope, fonts, viewport and the
 * browser/OS chrome colors.
 */
import { useEffect } from 'react'
import { isNativePlatform, nativePlatform } from '@/lib/native'
import './styles/tokens.css'
import './styles/ui.css'

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'

export function useNextDocument(): void {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('nx')
    try { localStorage.setItem('cumora.ui', 'next') } catch { /* storage disabled */ }
    // Chrome on Android: the soft keyboard resizes the layout viewport, so
    // the 100dvh shell shrinks around it instead of the page scrolling the
    // header away. The native app handles the keyboard itself (--kb-height).
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const original = viewport?.content
    if (viewport && original && !original.includes('interactive-widget')) {
      viewport.content = `${original}, interactive-widget=resizes-content`
    }
    if (!document.querySelector(`link[href="${FONT_HREF}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = FONT_HREF
      document.head.appendChild(link)
    }
    return () => {
      root.classList.remove('nx')
      if (viewport && original) viewport.content = original
    }
  }, [])
}

/**
 * Browser and OS chrome follow the redesign's surfaces in both modes: the
 * theme-color meta (Android Chrome's toolbar) and the native app's status
 * bar. lib/theme and lib/native paint the classic colors on every
 * `cumora:appearance` event, so this repaints one tick after them.
 */
export function useNativeChrome(): void {
  useEffect(() => {
    const paint = () => window.setTimeout(() => {
      const dark = document.documentElement.classList.contains('dark')
      const color = dark ? '#0a0a0b' : '#fafafa'
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
      if (isNativePlatform() && nativePlatform() === 'android') {
        void import('@capacitor/status-bar').then(({ StatusBar }) => StatusBar.setBackgroundColor({ color })).catch(() => {})
      }
    }, 0)
    paint()
    window.addEventListener('cumora:appearance', paint)
    return () => window.removeEventListener('cumora:appearance', paint)
  }, [])
}
