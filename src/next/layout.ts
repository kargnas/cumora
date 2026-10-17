import { useEffect, useState } from 'react'

/**
 * Region layout from the window width:
 *   stack  < 720   one screen at a time (list → chat → panel), pushed with swipe-back
 *   split  < 1180  sidebar + chat; the right panel opens over the chat
 *   full           sidebar + chat + docked right panel
 * Phone chrome (bottom tab bar, sheets, 44px targets) keys off the pointer,
 * not this value, so a narrow desktop window keeps mouse density.
 */
export type Layout = 'stack' | 'split' | 'full'

const STACK_MAX = 720
const SPLIT_MAX = 1180

function current(): Layout {
  const w = window.innerWidth
  return w < STACK_MAX ? 'stack' : w < SPLIT_MAX ? 'split' : 'full'
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(current)
  useEffect(() => {
    // rAF-coalesced: a window drag fires resize every frame, and each layout
    // switch remounts regions, so only commit the last value per frame.
    let raf = 0
    const on = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setLayout(current()))
    }
    window.addEventListener('resize', on)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', on)
    }
  }, [])
  return layout
}
