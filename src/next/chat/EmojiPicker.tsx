/**
 * Emoji picker above the composer: standard emoji (Twemoji glyphs) and the
 * animated Skype emoticons cumora renders from `(name)` shortcodes. The last
 * tab is remembered under the same key as the classic composer.
 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { COMPOSER_EMOJIS } from '@/lib/emoji'
import { SKYPE_EMOJIS, playSkypeSound } from '@/lib/skypeEmojis'
import { TwEmoji } from '@/components/TwEmoji'
import { SkypeEmoji } from '@/components/SkypeEmoji'
import { useSoundStore } from '@/stores/sound'
import { useNT } from '../i18n'
import { Segmented, T_QUICK } from '../ui/primitives'

type Tab = 'std' | 'skype'
const TAB_KEY = 'cumora.composer.emojiTab'

function initialTab(): Tab {
  try { return localStorage.getItem(TAB_KEY) === 'skype' ? 'skype' : 'std' } catch { return 'std' }
}

export function EmojiPicker({ onEmoji, onSkype, onClose }: {
  onEmoji: (emoji: string) => void
  onSkype: (key: string) => void
  onClose: () => void
}) {
  const nt = useNT()
  const [tab, setTab] = useState<Tab>(initialTab)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The toggle button handles its own click; closing here too would reopen it.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element
      if (ref.current?.contains(target) || target.closest('[data-emoji-toggle]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // A frame later, so the click that opened the picker does not close it.
    const raf = requestAnimationFrame(() => document.addEventListener('pointerdown', onDown))
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      className="nx-emoji"
      role="dialog"
      aria-label={nt('composer.emoji')}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={T_QUICK}
      // Keep the editor's caret: a pointerdown here would blur it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <Segmented
        label={nt('composer.emoji')}
        value={tab}
        onChange={(t) => { setTab(t); try { localStorage.setItem(TAB_KEY, t) } catch { /* private mode */ } }}
        items={[{ key: 'std', label: nt('composer.emojiStandard') }, { key: 'skype', label: nt('composer.emojiSkype') }]}
      />
      <div className="nx-emoji__grid nx-scroll" data-tab={tab}>
        {tab === 'std'
          ? COMPOSER_EMOJIS.map((e) => (
              <button key={e} type="button" className="nx-emoji__cell" aria-label={e} onClick={() => onEmoji(e)}>
                <TwEmoji emoji={e} size={22} />
              </button>
            ))
          : SKYPE_EMOJIS.map((e) => (
              <button
                key={e.key}
                type="button"
                className="nx-emoji__cell"
                aria-label={e.label}
                title={`${e.label} ${e.shortcodes[0]}`}
                onClick={() => {
                  onSkype(e.key)
                  // Same preview the classic picker plays, unless sounds are muted.
                  if (!useSoundStore.getState().muted) playSkypeSound(e.key)
                }}
              >
                <SkypeEmoji name={e.key} size={28} autoPlaySound={false} />
              </button>
            ))}
      </div>
    </motion.div>
  )
}
