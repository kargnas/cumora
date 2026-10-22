/**
 * The device's design choice in `localStorage['cumora.ui']`: `next` (Modern)
 * or `classic`, null until the device picks one. App.tsx reads it once, at
 * boot, to route `/` and to decide whether to show the design choice.
 */
const KEY = 'cumora.ui'

export type DesignPref = 'next' | 'classic'

/** Storage that cannot be read counts as Classic, so such a device is never
 *  asked; any other value (old, or written by hand) asks again. */
export function readDesignPref(): DesignPref | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'next' || v === 'classic' ? v : null
  } catch { return 'classic' }
}

/** False when storage refused the write (disabled, or full). */
export function writeDesignPref(ui: DesignPref): boolean {
  try { localStorage.setItem(KEY, ui); return true } catch { return false }
}

/** "Switch to classic design". Stays put when storage refused the choice:
 *  `/` would send the device straight back to `/next`. */
export function switchToClassic(): void {
  if (writeDesignPref('classic')) location.href = '/'
}
