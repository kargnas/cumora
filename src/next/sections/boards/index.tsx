/**
 * Boards section. Everything open is in the URL:
 *   /next/boards              board list (stack) or the last board (wide)
 *   /next/boards/:id          kanban
 *   /next/boards/:id?card=:c  card detail: docked on `full`, a sheet over the
 *                             board on `split`, a pushed screen on `stack`
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useMotionValue, useTransform, type MotionValue } from 'framer-motion'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { useAuth } from '@/stores/auth'
import { useBoards } from '@/stores/boards'
import { useNT } from '../../i18n'
import { getRoute, goBack, href, navigate, withRoute, type Route } from '../../router'
import type { Layout } from '../../layout'
import { SPRING_SHEET, Spinner, T_FAST } from '../../ui/primitives'
import { IBoard, IPlus } from '../../ui/icons'
import type { SectionProps } from '../types'
import { BoardList, type ListLoad } from './BoardList'
import { BoardView } from './BoardView'
import { CardSheet } from './CardSheet'
import { MentionProvider, errText } from './parts'
import './boards.css'

const LAST_BOARD_KEY = 'nx.lastBoard'

/** The board list, reloaded after a workspace switch (the store resets
 *  itself then). Only the newest request may settle the status. */
function useListLoad(): ListLoad {
  const epoch = useAuth((s) => s.contextEpoch)
  const [state, setState] = useState<{ status: ListLoad['status']; error: string }>({ status: 'loading', error: '' })
  const seq = useRef(0)
  const retry = useCallback(() => {
    const n = ++seq.current
    setState({ status: 'loading', error: '' })
    useBoards.getState().loadList().then(
      () => { if (seq.current === n) setState({ status: 'ready', error: '' }) },
      (e) => { if (seq.current === n) setState({ status: 'error', error: errText(e) }) },
    )
  }, [])
  // epoch is a trigger, not an input: a new workspace means a new list.
  useEffect(retry, [retry, epoch])
  return { ...state, retry }
}

/** Wide windows reopen a board instead of an empty canvas: the one classic
 *  code just asked for (the store's selection, e.g. "open full board" from a
 *  chat peek), else the last one viewed, else the newest. */
function useDefaultBoard(route: Route, layout: Layout, ready: boolean): void {
  const first = useBoards((s) => s.list[0]?.id ?? null)
  useEffect(() => {
    if (route.id) {
      localStorage.setItem(LAST_BOARD_KEY, route.id)
      // Classic readers (BoardLink, the store's refresh rule) keep seeing
      // the open board as the selected one.
      useBoards.setState({ selectedId: route.id })
      return
    }
    if (layout === 'stack' || !ready || !first) return
    const { list, selectedId } = useBoards.getState()
    const target = [selectedId, localStorage.getItem(LAST_BOARD_KEY)].find((id) => id && list.some((b) => b.id === id)) ?? first
    navigate(href({ section: 'boards', id: target }), { replace: true })
  }, [route.id, layout, ready, first])
}

/** A board that is gone (deleted here or elsewhere, or from another
 *  workspace) must not leave the URL pointing at nothing. */
function useBoardGuard(route: Route, stack: boolean, ready: boolean): void {
  const exists = useBoards((s) => !route.id || s.list.some((b) => b.id === route.id))
  useEffect(() => {
    if (!ready || exists || !route.id) return
    if (stack) goBack(href({ section: 'boards' }))
    else navigate(href({ section: 'boards' }), { replace: true })
  }, [ready, exists, route.id, stack])
}

/** Android Back closes the card, then the board (phones). Registered in the
 *  capture phase so it runs before the shell's handler, which would
 *  otherwise leave for Chats. */
function useHardwareBack(stack: boolean): void {
  useEffect(() => {
    const onBack = (e: Event) => {
      const r = getRoute()
      if (r.section !== 'boards') return
      if (r.id && r.search.get('card')) goBack(withRoute(r, { params: { card: null } }))
      else if (stack && r.id) goBack(href({ section: 'boards' }))
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('cumora:hardware-back', onBack, true)
    return () => window.removeEventListener('cumora:hardware-back', onBack, true)
  }, [stack])
}

const closeCard = () => goBack(withRoute(getRoute(), { params: { card: null } }))

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function useParallax(top: MotionValue<number>, w: number): MotionValue<number> {
  return useTransform(top, (v) => (-w * 0.3) + (Math.min(v, w) / w) * w * 0.3)
}

/** A pushed screen that slides in from the right; the screen under it
 *  peeks back with parallax. */
function Pushed({ w, x, swipe, z, children }: {
  w: number
  x: MotionValue<number>
  swipe?: ReturnType<typeof useSwipeBackProps>['props']
  z: number
  children: ReactNode
}) {
  return (
    <motion.div
      className="nx-pushed"
      initial={{ x: w }}
      animate={{ x: 0 }}
      exit={{ x: w }}
      transition={SPRING_SHEET}
      {...swipe}
      style={{ ...swipe?.style, x, zIndex: z }}
    >
      {children}
    </motion.div>
  )
}

function StackBoards({ route, cardId, list }: { route: Route; cardId: string | null; list: ReactNode }) {
  const w = useWidth()
  const boardOpen = route.id !== null
  const cardOpen = boardOpen && cardId !== null
  // The board screen has no swipe-back: a horizontal swipe there pages
  // between columns. Its header has the back button; the card screen on top
  // swipes back like any other pushed screen.
  const boardX = useMotionValue(0)
  const cardSwipe = useSwipeBackProps(closeCard)
  const baseX = useParallax(boardX, w)
  const boardInnerX = useParallax(cardSwipe.x, w)
  return (
    <div className="nx-stackview">
      <motion.div className="nx-stackview__base" style={{ x: boardOpen ? baseX : 0 }} {...(boardOpen ? { inert: '' } : {})}>
        {list}
      </motion.div>
      <AnimatePresence initial={false}>
        {boardOpen && (
          <Pushed key="board" w={w} x={boardX} z={1}>
            <motion.div className="nx-pushed__inner" style={{ x: cardOpen ? boardInnerX : 0 }} {...(cardOpen ? { inert: '' } : {})}>
              <BoardView key={route.id} boardId={route.id!} cardId={cardId} layout="stack" />
            </motion.div>
          </Pushed>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {cardOpen && (
          <Pushed key="card" w={w} x={cardSwipe.x} swipe={cardSwipe.props} z={2}>
            <CardSheet key={cardId} boardId={route.id!} cardId={cardId!} layout="stack" onClose={closeCard} />
          </Pushed>
        )}
      </AnimatePresence>
    </div>
  )
}

function NoBoard({ load, onCreate }: { load: ListLoad; onCreate: () => void }) {
  const nt = useNT()
  const count = useBoards((s) => s.list.length)
  return (
    <section className="nx-boards-board nx-boards-board--empty">
      {load.status === 'loading' && count === 0 ? (
        <Spinner large label={nt('boards.loading')} />
      ) : load.status === 'error' && count === 0 ? (
        <div className="nx-empty" role="alert">
          <b>{nt('boards.loadFailed')}</b>
          {load.error}
          <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={load.retry}>{nt('boards.retry')}</button>
        </div>
      ) : count === 0 ? (
        <div className="nx-empty">
          <span className="nx-boards-empty-icon"><IBoard /></span>
          <b>{nt('boards.empty')}</b>
          {nt('boards.emptyBody')}
          <button type="button" className="nx-btn nx-btn--primary" onClick={onCreate}>
            <IPlus />
            {nt('boards.createFirst')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function WideBoards({ route, layout, cardId, list, load, onCreate }: {
  route: Route
  layout: Layout
  cardId: string | null
  list: ReactNode
  load: ListLoad
  onCreate: () => void
}) {
  const open = route.id !== null && cardId !== null
  const dock = layout === 'full' && open
  return (
    <div className="nx-boards" data-layout={layout} data-sheet={dock ? 'dock' : undefined}>
      {list}
      {route.id ? <BoardView key={route.id} boardId={route.id} cardId={cardId} layout={layout} /> : <NoBoard load={load} onCreate={onCreate} />}
      {layout === 'full' ? (
        dock && (
          <motion.div className="nx-boards-dock" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={T_FAST}>
            <CardSheet key={cardId} boardId={route.id!} cardId={cardId!} layout={layout} onClose={closeCard} />
          </motion.div>
        )
      ) : (
        <AnimatePresence>
          {open && (
            <div className="nx-boards-overlay" key="sheet">
              <motion.div className="nx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T_FAST} onClick={closeCard} />
              <motion.div className="nx-boards-overlay__sheet" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={SPRING_SHEET}>
                <CardSheet key={cardId} boardId={route.id!} cardId={cardId!} layout={layout} onClose={closeCard} />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

export default function BoardsSection({ route, layout, stack }: SectionProps) {
  const load = useListLoad()
  const ready = load.status === 'ready'
  useDefaultBoard(route, layout, ready)
  useBoardGuard(route, stack, ready)
  useHardwareBack(stack)
  // Typing a new board name is not navigation, so it is not in the URL.
  const [creating, setCreating] = useState(false)
  const cardId = route.id ? route.search.get('card') : null
  const list = <BoardList activeId={route.id} load={load} creating={creating} setCreating={setCreating} stack={stack} />
  return (
    <MentionProvider>
      {stack
        ? <StackBoards route={route} cardId={cardId} list={list} />
        : <WideBoards route={route} layout={layout} cardId={cardId} list={list} load={load} onCreate={() => setCreating(true)} />}
    </MentionProvider>
  )
}
