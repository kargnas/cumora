/** Date/time formatting for the redesign. Everything renders in the viewer's
 *  own timezone through Intl, so a traveller sees their local clock. */
import type { Locale } from '@/lib/i18n'

const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts)
    cache.set(key, f)
  }
  return f
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Sidebar stamp: time today, weekday within a week, else a short date. */
export function listStamp(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return fmt(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
  if (days < 7) return fmt(locale, { weekday: 'short' }).format(d)
  return fmt(locale, { month: 'short', day: 'numeric' }).format(d)
}

/** Day separator label for the transcript. */
export function dayLabel(d: Date, locale: Locale, today: string, yesterday: string): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days === 0) return today
  if (days === 1) return yesterday
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return fmt(locale, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(d)
}

export function clock(d: Date, locale: Locale): string {
  return fmt(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
}

/** "0:42", "12:05", "1:02:09" — elapsed time for live work. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "42s", "3m 05s", "1h 02m" — finished durations. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
