/**
 * Kanban for one board. Cards move by mouse drag, by touch (hold, then
 * drag), from the keyboard (Alt+arrows on a focused card) and from the card
 * menu ("Move to"). Every move goes through the store's optimistic move,
 * which refetches the board when the server refuses, and cards glide to
 * their new slots through shared layout animations instead of jumping.
 */
import {
  createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject,
} from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { isMac } from '@/lib/runtime'
import type { BoardCard, BoardColumn } from '@/types'
import { useNT, type NT } from '../../i18n'
import { getRoute, goBack, href, navigate, withRoute } from '../../router'
import type { Layout } from '../../layout'
import { Avatar } from '../../ui/Avatar'
import { IconButton, Menu, Portal, Spinner, T_FAST, anchorFrom, useMenu, type MenuAnchor, type MenuEntry } from '../../ui/primitives'
import { IArrowDown, IArrowUp, IAt, IChat, ICheck, IChevronLeft, IMore, IPanelRight, IPencil, IPlus, ITrash, IX } from '../../ui/icons'
import { cardsIn, useCardDrag, type DragBind, type DragView, type Ghost } from './drag'
import { DueChip, InlineEdit, KindDot, MentionField, RichText, errText, useToday, type Kind } from './parts'
import { confirmDeleteBoard } from './BoardList'

const NO_COLUMNS: BoardColumn[] = []
const NO_NAMES: string[] = []
const KINDS: Kind[] = ['todo', 'doing', 'done', null]

function kindLabel(nt: NT, k: Kind): string {
  return k === 'todo' ? nt('boards.kindTodo') : k === 'doing' ? nt('boards.kindDoing') : k === 'done' ? nt('boards.kindDone') : nt('boards.kindNone')
}

/** Cards already shown this session. Cards that appear later (made here,
 *  by a teammate or by an agent) play an entrance; reopening a board
 *  replays nothing. */
const seen = new Set<string>()
const primed = new Set<string>()

interface BoardActions {
  open: (cardId: string) => void
  menu: (cardId: string, anchor: MenuAnchor) => void
  nudge: (cardId: string, dCol: number, dIdx: number) => void
  drag: DragBind
}

const BoardCtx = createContext<BoardActions | null>(null)

const MOVES: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
}

/* ── Card ───────────────────────────────────────────────────────────── */

/** What a card shows: title with chips, then due date, mentions, comment
 *  count and assignee. Shared by the tile and the drag ghost. */
const CardFace = memo(function CardFace({ card, kind, asOf }: { card: BoardCard; kind: Kind; asOf: string }) {
  const nt = useNT()
  const assignee = useParticipants((s) => (card.assigneeId ? s.byId[card.assigneeId] : undefined))
  // Mentions only show on unassigned cards, as on the classic board: an
  // assignee already says who the card is for.
  const mentioned = useParticipants(useShallow((s) => (card.assigneeId ? NO_NAMES : card.mentions.map((m) => s.byId[m]?.name ?? m))))
  const meta = card.dueOn || mentioned.length > 0 || card.commentCount > 0 || assignee
  return (
    <>
      <span className="nx-boards-card__title"><RichText text={card.title} quiet /></span>
      {meta && (
        <span className="nx-boards-card__meta">
          {card.dueOn && <DueChip dueOn={card.dueOn} kind={kind} asOf={asOf} />}
          {mentioned.length > 0 && (
            <span className="nx-boards-card__at" title={nt('boards.mentions', { names: mentioned.join(', ') })}>
              <IAt />
              <span>{mentioned.join(', ')}</span>
            </span>
          )}
          <span className="nx-boards-card__end">
            {card.commentCount > 0 && (
              <span className="nx-boards-card__count nx-mono" title={nt('boards.commentCount', { n: card.commentCount })}>
                <IChat />
                {card.commentCount}
              </span>
            )}
            {assignee && (
              <span className="nx-boards-card__who" title={nt('boards.assignedTo', { name: assignee.name })}>
                <Avatar p={assignee} size={20} />
                <span className="nx-boards-sr">{nt('boards.assignedTo', { name: assignee.name })}</span>
              </span>
            )}
          </span>
        </span>
      )}
    </>
  )
})

const CardTile = memo(function CardTile({ card, kind, asOf, active }: { card: BoardCard; kind: Kind; asOf: string; active: boolean }) {
  const ctx = useContext(BoardCtx)!
  const [fresh] = useState(() => {
    if (seen.has(card.id)) return false
    seen.add(card.id)
    return true
  })
  return (
    <motion.div
      // Position only: a size change (a title edit that wraps) would
      // otherwise scale the text mid-animation.
      layout="position"
      // Shared id: a card that changes columns unmounts in one list and
      // mounts in another, and glides across instead of blinking.
      layoutId={`nx-boards-card-${card.id}`}
      transition={T_FAST}
      initial={fresh ? { opacity: 0, scale: 0.96 } : false}
      animate={{ opacity: 1, scale: 1 }}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Shift+F10"
      data-card={card.id}
      className="nx-boards-card"
      onClick={() => ctx.open(card.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          ctx.open(card.id)
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault()
          ctx.menu(card.id, anchorFrom(e.currentTarget))
        } else if (e.altKey && MOVES[e.key]) {
          e.preventDefault()
          ctx.nudge(card.id, MOVES[e.key][0], MOVES[e.key][1])
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!ctx.drag.busy()) ctx.menu(card.id, { x: e.clientX, y: e.clientY })
      }}
      onPointerDown={(e) => ctx.drag.onPointerDown(e, card)}
      onTouchStart={(e) => ctx.drag.onTouchStart(e, card)}
    >
      <CardFace card={card} kind={kind} asOf={asOf} />
    </motion.div>
  )
})

function GhostCard({ view, ghost, kind, asOf }: { view: DragView; ghost: Ghost; kind: Kind; asOf: string }) {
  return (
    <Portal>
      <motion.div
        className="nx-boards-ghost"
        style={{ x: ghost.x, y: ghost.y, scale: ghost.scale, rotate: ghost.rotate, width: view.w }}
        aria-hidden
      >
        {/* The target column's status: carrying an overdue card into Done
            already shows its due date as settled. */}
        <div className="nx-boards-card nx-boards-card--lifted"><CardFace card={view.card} kind={kind} asOf={asOf} /></div>
      </motion.div>
    </Portal>
  )
}

/* ── Column ─────────────────────────────────────────────────────────── */

function CardComposer({ boardId, column, list, onDone }: {
  boardId: string
  column: BoardColumn
  list: RefObject<HTMLDivElement>
  onDone: () => void
}) {
  const nt = useNT()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A blur that lands while a card is saving closes the composer afterwards.
  const leave = useRef(false)
  const submit = async (close: boolean) => {
    leave.current = leave.current || close
    if (busy) return
    const title = draft.trim()
    if (!title) {
      if (leave.current) onDone()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().addCard(boardId, { columnId: column.id, title })
      setDraft('')
      requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }))
      if (leave.current) { onDone(); return }
    } catch (e) {
      setError(errText(e))
      leave.current = false
    }
    setBusy(false)
  }
  return (
    <div className="nx-boards-composer">
      <MentionField
        multiline
        enterSubmits
        rows={2}
        autoFocus
        value={draft}
        onChange={setDraft}
        readOnly={busy}
        label={nt('boards.cardLabel', { column: column.title })}
        placeholder={nt('boards.cardPlaceholder')}
        onSubmit={() => void submit(false)}
        onCancel={onDone}
        onBlur={() => void submit(true)}
      />
      {busy && <Spinner label={nt('boards.addCard')} />}
      {error && <span className="nx-boards-error" role="alert">{error}</span>}
    </div>
  )
}

const Column = memo(function Column({ boardId, column, asOf, openId, dragId, ph, renaming, setRenaming, onMenu }: {
  boardId: string
  column: BoardColumn
  asOf: string
  openId: string | null
  dragId: string | null
  /** Drop slot in this column while a card is carried over it. */
  ph: { index: number; h: number } | null
  renaming: boolean
  setRenaming: (columnId: string | null) => void
  onMenu: (columnId: string, anchor: MenuAnchor) => void
}) {
  const nt = useNT()
  const cards = useBoards(useShallow((s) => cardsIn(s.snapshots[boardId], column.id)))
  const list = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)

  const shown = dragId ? cards.filter((c) => c.id !== dragId) : cards
  const items = shown.map((c) => <CardTile key={c.id} card={c} kind={column.kind} asOf={asOf} active={c.id === openId} />)
  if (ph) {
    items.splice(Math.min(ph.index, items.length), 0, (
      <motion.div key="nx-ph" layout="position" transition={T_FAST} className="nx-boards-ph" data-placeholder="" style={{ height: ph.h }} />
    ))
  }

  return (
    <motion.section layout="position" transition={T_FAST} className="nx-boards-col" aria-label={column.title}>
      <header className="nx-boards-col__head">
        <KindDot kind={column.kind} />
        {renaming ? (
          <InlineEdit
            className="nx-boards-col__edit"
            initial={column.title}
            label={nt('boards.renameColumn')}
            placeholder={nt('boards.columnPlaceholder')}
            onSave={(v) => useBoards.getState().renameColumn(boardId, column.id, v)}
            onDone={() => setRenaming(null)}
          />
        ) : (
          <>
            <button type="button" className="nx-boards-col__title" onClick={() => setRenaming(column.id)}>{column.title}</button>
            <span className="nx-boards-col__count nx-mono">{cards.length}</span>
          </>
        )}
        <IconButton small label={nt('boards.columnMenu', { title: column.title })} onClick={(e) => onMenu(column.id, anchorFrom(e.currentTarget, 'end'))}>
          <IMore />
        </IconButton>
      </header>
      <motion.div ref={list} layoutScroll className="nx-boards-col__cards nx-scroll" data-col-list={column.id}>
        {items}
      </motion.div>
      <footer className="nx-boards-col__foot">
        {adding ? (
          <CardComposer boardId={boardId} column={column} list={list} onDone={() => setAdding(false)} />
        ) : (
          <button type="button" className="nx-btn nx-btn--sm nx-btn--block nx-boards-col__add" onClick={() => setAdding(true)}>
            <IPlus />
            {nt('boards.addCard')}
          </button>
        )}
      </footer>
    </motion.section>
  )
})

function AddColumn({ boardId, open, setOpen, canvas }: {
  boardId: string
  open: boolean
  setOpen: (v: boolean) => void
  canvas: RefObject<HTMLDivElement>
}) {
  const nt = useNT()
  if (!open) {
    return (
      <button type="button" className="nx-boards-addcol" onClick={() => setOpen(true)}>
        <IPlus />
        {nt('boards.addColumn')}
      </button>
    )
  }
  return (
    <div className="nx-boards-addcol nx-boards-addcol--edit">
      <InlineEdit
        label={nt('boards.addColumn')}
        placeholder={nt('boards.columnPlaceholder')}
        onSave={async (v) => {
          await useBoards.getState().addColumn(boardId, v)
          requestAnimationFrame(() => canvas.current?.scrollTo({ left: canvas.current.scrollWidth, behavior: 'smooth' }))
        }}
        onDone={() => setOpen(false)}
      />
    </div>
  )
}

/* ── Header ─────────────────────────────────────────────────────────── */

function BoardHeader({ boardId, layout, refreshing, onAddColumn, onError }: {
  boardId: string
  layout: Layout
  refreshing: boolean
  onAddColumn: () => void
  onError: (message: string) => void
}) {
  const nt = useNT()
  const title = useBoards((s) => s.snapshots[boardId]?.title ?? s.list.find((b) => b.id === boardId)?.title ?? '')
  const description = useBoards((s) => s.snapshots[boardId]?.description ?? null)
  const [renaming, setRenaming] = useState(false)
  const menu = useMenu()
  return (
    <header className="nx-boards-head">
      {layout === 'stack' && (
        <IconButton label={nt('boards.back')} onClick={() => goBack(href({ section: 'boards' }))}><IChevronLeft /></IconButton>
      )}
      <div className="nx-boards-head__text">
        {renaming ? (
          <InlineEdit
            initial={title}
            label={nt('boards.rename')}
            placeholder={nt('boards.namePlaceholder')}
            onSave={(v) => useBoards.getState().renameBoard(boardId, v)}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <h2 className="nx-boards-head__title"><button type="button" onClick={() => setRenaming(true)}>{title}</button></h2>
        )}
        {description && !renaming && <p className="nx-boards-head__desc"><RichText text={description} /></p>}
      </div>
      {refreshing && <Spinner label={nt('boards.refreshing')} />}
      <IconButton label={nt('boards.boardMenu')} tipPlace="below" onClick={(e) => menu.toggleFrom(e.currentTarget, 'end')}>
        <IMore />
      </IconButton>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { key: 'rename', label: nt('boards.rename'), icon: <IPencil />, onSelect: () => setRenaming(true) },
          { key: 'column', label: nt('boards.addColumn'), icon: <IPlus />, onSelect: onAddColumn },
          'sep',
          {
            key: 'delete',
            label: nt('boards.deleteBoard'),
            icon: <ITrash />,
            danger: true,
            onSelect: () => {
              confirmDeleteBoard({ id: boardId, title }, nt('boards.deleteBoardConfirm', { title })).catch((e) => onError(errText(e)))
            },
          },
        ]}
      />
    </header>
  )
}

/* ── Board ──────────────────────────────────────────────────────────── */

function BoardSkeleton() {
  return (
    <div className="nx-boards-canvas" aria-busy="true">
      {[3, 2, 1].map((n) => (
        <div key={n} className="nx-boards-col nx-boards-col--skel">
          <span className="nx-skel nx-boards-skel-title" />
          {Array.from({ length: n }, (_, i) => <span key={i} className="nx-skel nx-boards-skel-card" />)}
        </div>
      ))}
    </div>
  )
}

export function BoardView({ boardId, cardId, layout }: { boardId: string; cardId: string | null; layout: Layout }) {
  const nt = useNT()
  const hasSnap = useBoards((s) => Boolean(s.snapshots[boardId]))
  const columns = useBoards((s) => s.snapshots[boardId]?.columns ?? NO_COLUMNS)
  const title = useBoards((s) => s.snapshots[boardId]?.title ?? '')
  const asOf = useToday()
  const canvas = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<{ status: 'loading' | 'ready' | 'error'; error: string }>({ status: 'loading', error: '' })
  const [notice, setNotice] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null)
  // One column menu for the board: opening it re-renders only this view, not
  // a column, whose re-render makes every card on the board re-measure.
  const [colMenu, setColMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null)
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [addingColumn, setAddingColumn] = useState(false)

  // A cached snapshot renders at once; this refetch only shows a header spinner.
  const reload = useCallback(() => {
    setLoad({ status: 'loading', error: '' })
    useBoards.getState().loadBoard(boardId).then(
      () => setLoad({ status: 'ready', error: '' }),
      (e) => setLoad({ status: 'error', error: errText(e) }),
    )
  }, [boardId])
  useEffect(reload, [reload])

  if (hasSnap && !primed.has(boardId)) {
    primed.add(boardId)
    for (const c of useBoards.getState().snapshots[boardId]?.cards ?? []) seen.add(c.id)
  }

  const open = useCallback((id: string) => {
    const r = getRoute()
    // Switching cards while the sheet is up replaces, so Back closes it.
    navigate(withRoute(r, { params: { card: id } }), { replace: r.search.has('card') })
  }, [])

  /** Keyboard and menu moves: the card keeps focus in its new slot, and a
   *  screen reader hears where it went. */
  const moveTo = useCallback((id: string, to: string, index: number) => {
    const s = useBoards.getState()
    void s.moveCardOptimistic(boardId, id, to, index)
    const snap = useBoards.getState().snapshots[boardId]
    const list = cardsIn(snap, to)
    const col = snap?.columns.find((c) => c.id === to)
    setSaid(nt('boards.moved', { column: col?.title ?? '', pos: list.findIndex((c) => c.id === id) + 1, total: list.length }))
    requestAnimationFrame(() => canvas.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus())
  }, [boardId, nt])

  const nudge = useCallback((id: string, dCol: number, dIdx: number) => {
    const snap = useBoards.getState().snapshots[boardId]
    const card = snap?.cards.find((c) => c.id === id)
    if (!snap || !card) return
    const here = cardsIn(snap, card.columnId)
    const idx = here.findIndex((c) => c.id === id)
    if (dCol !== 0) {
      const col = snap.columns[snap.columns.findIndex((c) => c.id === card.columnId) + dCol]
      if (col) moveTo(id, col.id, Math.min(idx, cardsIn(snap, col.id).length))
    } else if (idx + dIdx >= 0 && idx + dIdx < here.length) {
      moveTo(id, card.columnId, idx + dIdx)
    }
  }, [boardId, moveTo])

  const drag = useCardDrag(boardId, canvas, (id, x, y) => setMenu({ id, anchor: { x, y } }))
  // Phones: column snapping is off while a card is carried; when it comes
  // back, the browser re-snaps to the column the drag started from. Bring
  // the drop column back into view instead.
  const dropColumn = useRef<string | null>(null)
  useEffect(() => {
    if (drag.view) { dropColumn.current = drag.view.to; return }
    const to = dropColumn.current
    dropColumn.current = null
    if (!to || layout !== 'stack') return
    canvas.current?.querySelector(`[data-col-list="${CSS.escape(to)}"]`)?.parentElement
      ?.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' })
  }, [drag.view, layout])
  const actions = useMemo<BoardActions>(
    () => ({ open, menu: (id, anchor) => setMenu({ id, anchor }), nudge, drag: drag.bind }),
    [open, nudge, drag.bind],
  )

  // Focus returns to the card whose sheet just closed.
  const lastOpen = useRef<string | null>(null)
  useEffect(() => {
    if (cardId) { lastOpen.current = cardId; return }
    const id = lastOpen.current
    lastOpen.current = null
    if (id) canvas.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  }, [cardId])

  const menuCard = useBoards((s) => (menu ? s.snapshots[boardId]?.cards.find((c) => c.id === menu.id) : undefined))
  const entries = useMemo<MenuEntry[]>(() => {
    if (!menuCard) return []
    const snap = useBoards.getState().snapshots[boardId]
    const here = cardsIn(snap, menuCard.columnId)
    const idx = here.findIndex((c) => c.id === menuCard.id)
    const alt = isMac ? '⌥' : 'Alt+'
    const remove = () => {
      if (!window.confirm(nt('boards.deleteCardConfirm', { title: menuCard.title }))) return
      useBoards.getState().deleteCard(boardId, menuCard.id).then(
        () => { if (getRoute().search.get('card') === menuCard.id) goBack(withRoute(getRoute(), { params: { card: null } })) },
        (e) => setNotice(errText(e)),
      )
    }
    // Moves that cannot happen are left out rather than greyed: the shared
    // menu draws disabled items like live ones.
    const steps: MenuEntry[] = [
      ...(idx > 0 ? [{ key: 'up', label: nt('boards.moveUp'), icon: <IArrowUp />, shortcut: `${alt}↑`, onSelect: () => nudge(menuCard.id, 0, -1) }] : []),
      ...(idx < here.length - 1 ? [{ key: 'down', label: nt('boards.moveDown'), icon: <IArrowDown />, shortcut: `${alt}↓`, onSelect: () => nudge(menuCard.id, 0, 1) }] : []),
    ]
    return [
      { key: 'open', label: nt('boards.open'), icon: <IPanelRight />, onSelect: () => open(menuCard.id) },
      'sep',
      { label: nt('boards.moveTo') },
      // The current column stays listed, checked, so the list reads as the
      // card's status; picking it changes nothing.
      ...columns.map((col): MenuEntry => ({
        key: `to-${col.id}`,
        label: col.title,
        icon: col.id === menuCard.columnId ? <ICheck /> : <KindDot kind={col.kind} />,
        onSelect: () => { if (col.id !== menuCard.columnId) moveTo(menuCard.id, col.id, cardsIn(snap, col.id).length) },
      })),
      ...(steps.length ? ['sep' as const, ...steps] : []),
      'sep',
      { key: 'delete', label: nt('boards.deleteCard'), icon: <ITrash />, danger: true, onSelect: remove },
    ]
  }, [menuCard, columns, boardId, nt, open, moveTo, nudge])

  const openColumnMenu = useCallback((id: string, anchor: MenuAnchor) => setColMenu({ id, anchor }), [])
  const menuCol = colMenu ? columns.find((c) => c.id === colMenu.id) : undefined
  const colEntries = useMemo<MenuEntry[]>(() => {
    if (!menuCol) return []
    const remove = () => {
      const n = cardsIn(useBoards.getState().snapshots[boardId], menuCol.id).length
      const ask = n === 1
        ? nt('boards.deleteColumnConfirmOne', { title: menuCol.title })
        : nt('boards.deleteColumnConfirm', { title: menuCol.title, n })
      if (n > 0 && !window.confirm(ask)) return
      useBoards.getState().deleteColumn(boardId, menuCol.id).catch((e) => setNotice(errText(e)))
    }
    return [
      { key: 'rename', label: nt('boards.renameColumn'), icon: <IPencil />, onSelect: () => setRenamingCol(menuCol.id) },
      'sep',
      { label: nt('boards.status') },
      ...KINDS.map((k): MenuEntry => ({
        key: `kind-${k ?? 'none'}`,
        label: kindLabel(nt, k),
        icon: menuCol.kind === k ? <ICheck /> : <KindDot kind={k} />,
        onSelect: () => { useBoards.getState().setColumnKind(boardId, menuCol.id, k).catch((e) => setNotice(errText(e))) },
      })),
      'sep',
      { key: 'delete', label: nt('boards.deleteColumn'), icon: <ITrash />, danger: true, onSelect: remove },
    ]
  }, [menuCol, boardId, nt])

  const addColumn = () => {
    setAddingColumn(true)
    requestAnimationFrame(() => canvas.current?.scrollTo({ left: canvas.current.scrollWidth, behavior: 'smooth' }))
  }

  const view = drag.view
  return (
    <BoardCtx.Provider value={actions}>
      <section className="nx-boards-board" data-layout={layout} aria-label={title}>
        <BoardHeader
          boardId={boardId}
          layout={layout}
          refreshing={hasSnap && load.status === 'loading'}
          onAddColumn={addColumn}
          onError={setNotice}
        />
        {notice && (
          <div className="nx-boards-notice" role="alert">
            <span>{notice}</span>
            <IconButton small label={nt('boards.dismiss')} onClick={() => setNotice(null)}><IX /></IconButton>
          </div>
        )}
        {/* A failed refetch keeps the cached board on screen, but says so. */}
        {hasSnap && load.status === 'error' && (
          <div className="nx-boards-notice" role="alert">
            <span>{nt('boards.refreshFailed', { error: load.error })}</span>
            <button type="button" className="nx-btn nx-btn--sm" onClick={reload}>{nt('boards.retry')}</button>
          </div>
        )}
        {!hasSnap && load.status === 'error' ? (
          <div className="nx-empty nx-boards-fill" role="alert">
            <b>{nt('boards.boardFailed')}</b>
            {load.error}
            <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={reload}>{nt('boards.retry')}</button>
          </div>
        ) : !hasSnap ? (
          <BoardSkeleton />
        ) : (
          <LayoutGroup id={`nx-board-${boardId}`}>
            <motion.div ref={canvas} layoutScroll className="nx-boards-canvas nx-scroll" data-dragging={view ? '' : undefined}>
              {columns.map((col) => (
                <Column
                  key={col.id}
                  boardId={boardId}
                  column={col}
                  asOf={asOf}
                  openId={cardId}
                  dragId={view?.card.id ?? null}
                  ph={view?.to === col.id ? view : null}
                  renaming={renamingCol === col.id}
                  setRenaming={setRenamingCol}
                  onMenu={openColumnMenu}
                />
              ))}
              <AddColumn boardId={boardId} open={addingColumn} setOpen={setAddingColumn} canvas={canvas} />
            </motion.div>
          </LayoutGroup>
        )}
        <div className="nx-boards-sr" aria-live="polite">{said}</div>
        <Menu open={menu !== null && menuCard !== undefined} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} entries={entries} />
        <Menu open={menuCol !== undefined} anchor={colMenu?.anchor ?? null} onClose={() => setColMenu(null)} entries={colEntries} />
        {view && <GhostCard view={view} ghost={drag.ghost} kind={columns.find((c) => c.id === view.to)?.kind ?? null} asOf={asOf} />}
      </section>
    </BoardCtx.Provider>
  )
}
