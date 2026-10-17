import { registerPlugin } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { isNativePlatform, nativePlatform } from '@/lib/native'

/**
 * Haptics for the redesign. Each kind names what happened, not how strong it
 * feels; AGENTS.md ("Haptics") says which interaction gets which kind.
 *
 * - select: the finger changed what is chosen (tab, segment, switch, menu
 *   item, reaction, collapsed group).
 * - tap: the finger committed a light action that shows at once (send, drop).
 * - hold: a press turned into a hold (long-press menu, drag lift).
 * - success / error: an action the user waited on finished or failed.
 *
 * Native apps only: the web and the desktop app have nothing to vibrate.
 * Fire it in the same handler as the visual change, never from a store or an
 * effect, so it lines up with the frame the user sees.
 */
export type HapticKind = 'select' | 'tap' | 'hold' | 'success' | 'error'

// Android plays the system's own effects (android/.../NxHapticsPlugin.java);
// @capacitor/haptics would play fixed vibration waveforms there.
const NxHaptics = registerPlugin<{ perform(o: { kind: HapticKind }): Promise<void> }>('NxHaptics')

const ios: Record<HapticKind, () => Promise<void>> = {
  select: async () => {
    await Haptics.selectionStart()
    await Haptics.selectionChanged()
    await Haptics.selectionEnd()
  },
  tap: () => Haptics.impact({ style: ImpactStyle.Light }),
  hold: () => Haptics.impact({ style: ImpactStyle.Medium }),
  success: () => Haptics.notification({ type: NotificationType.Success }),
  error: () => Haptics.notification({ type: NotificationType.Error }),
}

export function haptic(kind: HapticKind): void {
  if (!isNativePlatform()) return
  const run = nativePlatform() === 'android' ? NxHaptics.perform({ kind }) : ios[kind]()
  // A missing vibrator or an older APK without the plugin must not surface as
  // an unhandled rejection; the action itself already happened.
  run.catch(() => {})
}
