import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion'
import { useConversations } from '@/stores/conversations'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { goBack, href, navigate, withRoute, type Route } from '../router'
import type { Layout } from '../layout'
import { SPRING_SHEET, T_FAST } from '../ui/primitives'
import { RightPanel } from '../panel/RightPanel'
import { Sidebar } from './Sidebar'
import { ChatEmpty, ChatView } from './ChatView'

const LAST_ROOM_KEY = 'nx.lastRoom'

/** Whether the right panel shows for this route at this width. Thread and
 *  peeks always show; tabs show when asked, or by default on wide windows. */
export function panelVisible(route: Route, layout: Layout): boolean {
  if (route.section !== 'chats' || !route.id) return false
  if (route.threadId || route.peek) return true
  if (route.panel === 'none') return false
  return route.panel !== null || layout === 'full'
}

/** `/next` on a wide window opens the room you were last in (or the newest),
 *  the way a desktop messenger reopens where you left off. */
function useDefaultRoom(route: Route, layout: Layout): void {
  const loaded = useConversations((s) => s.loaded)
  const first = useConversations((s) => s.list.find((c) => c.kind !== 'whisper')?.id ?? null)
  useEffect(() => {
    if (route.id) {
      localStorage.setItem(LAST_ROOM_KEY, route.id)
      return
    }
    if (layout === 'stack' || !loaded) return
    const last = localStorage.getItem(LAST_ROOM_KEY)
    const exists = last && useConversations.getState().list.some((c) => c.id === last)
    const target = exists ? last : first
    if (target) navigate(href({ section: 'chats', id: target }), { replace: true })
  }, [route.id, layout, loaded, first])
}

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** A pushed screen: slides in from the right, follows the finger on a swipe
 *  from anywhere, and the screen underneath peeks back with parallax. */
function Pushed({ swipe, z, children }: { swipe: ReturnType<typeof useSwipeBackProps>; z: number; children: ReactNode }) {
  const w = useWidth()
  return (
    <motion.div
      className="nx-pushed"
      initial={{ x: w }}
      animate={{ x: 0 }}
      exit={{ x: w }}
      transition={SPRING_SHEET}
      {...swipe.props}
      style={{ ...swipe.props.style, zIndex: z }}
    >
      {children}
    </motion.div>
  )
}

function useParallax(top: MotionValue<number>, w: number): MotionValue<number> {
  return useTransform(top, (v) => (-w * 0.3) + (Math.min(v, w) / w) * w * 0.3)
}

function StackChats({ route }: { route: Route }) {
  const w = useWidth()
  const chatOpen = route.id !== null
  const panelOpen = panelVisible(route, 'stack')
  const chatSwipe = useSwipeBackProps(() => goBack(href({ section: 'chats' })))
  const panelSwipe = useSwipeBackProps(() => goBack(withRoute(route, { panel: null, peek: null, threadId: null })))
  const baseX = useParallax(chatSwipe.x, w)
  const chatX = useParallax(panelSwipe.x, w)
  return (
    <div className="nx-stackview">
      <motion.div className="nx-stackview__base" style={{ x: chatOpen ? baseX : 0 }} {...(chatOpen ? { inert: '' } : {})}>
        <Sidebar activeId={route.id} />
      </motion.div>
      <AnimatePresence initial={false}>
        {chatOpen && (
          <Pushed key="chat" swipe={chatSwipe} z={1}>
            <motion.div className="nx-pushed__inner" style={{ x: panelOpen ? chatX : 0 }} {...(panelOpen ? { inert: '' } : {})}>
              <ChatView convoId={route.id!} layout="stack" panelOpen={panelOpen} />
            </motion.div>
          </Pushed>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {chatOpen && panelOpen && (
          <Pushed key="panel" swipe={panelSwipe} z={2}>
            <RightPanel route={route} layout="stack" />
          </Pushed>
        )}
      </AnimatePresence>
    </div>
  )
}

export function ChatsSection({ route, layout }: { route: Route; layout: Layout }) {
  useDefaultRoom(route, layout)
  if (layout === 'stack') return <StackChats route={route} />
  const open = panelVisible(route, layout)
  return (
    <div className="nx-chats" data-panel={open && layout === 'full' ? 'dock' : undefined}>
      <Sidebar activeId={route.id} />
      {route.id ? <ChatView convoId={route.id} layout={layout} panelOpen={open} /> : <ChatEmpty />}
      {layout === 'full' ? (
        open && route.id && (
          <motion.div className="nx-panel-dock" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={T_FAST}>
            <RightPanel route={route} layout={layout} />
          </motion.div>
        )
      ) : (
        <AnimatePresence>
          {open && route.id && (
            <div className="nx-panel-overlay" key="overlay">
              <motion.div
                className="nx-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={T_FAST}
                onClick={() => goBack(withRoute(route, { panel: null, peek: null, threadId: null }))}
              />
              <motion.div
                className="nx-panel-sheet"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={SPRING_SHEET}
              >
                <RightPanel route={route} layout={layout} />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}
