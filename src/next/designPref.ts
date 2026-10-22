/**
 * The device's design choice in `localStorage['cumora.ui']`: `next` (Modern)
 * or `classic`, null until the device picks one. App.tsx reads it once, at
 * boot, to route `/` and to decide whether to show the design choice.
 */
const KEY = 'cumora.ui'

export type DesignPref = 'next' | 'classic'

/** Storage that cannot be read counts as Classic, so such a device is never asked. */
export function readDesignPref(): string | null {
  try { return localStorage.getItem(KEY) } catch { return 'classic' }
}

/** False when storage refused the write (disabled, or full). */
export function writeDesignPref(ui: DesignPref): boolean {
  try { localStorage.setItem(KEY, ui); return true } catch { return false }
}
