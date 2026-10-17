import { memo, useState } from 'react'
import { motion } from 'framer-motion'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { BoardSummary } from '@/types'
import { useNT } from '../../i18n'
import { href, linkClick, navigate } from '../../router'
import { listStamp } from '../../format'
import { useHold } from '../../hooks'
import { IconButton, Menu, Spinner, T_FAST, useMenu } from '../../ui/primitives'
import { IBoard, IPencil, IPlus, ITrash } from '../../ui/icons'
import { InlineEdit, errText } from './parts'

export interface ListLoad {
  status: 'loading' | 'ready' | 'error'
  error: string
  retry: () => void
}

async function createBoardAndOpen(title: string): Promise<void> {
  const id = await useBoards.getState().createBoard(title)
  navigate(href({ section: 'boards', id }))
}

/** Delete after a confirm; the section's guard leaves the URL of a board
 *  that no longer exists. */
export async function confirmDeleteBoard(b: { id: string; title: string }, confirmText: string): Promise<void> {
  if (!window.confirm(confirmText)) return
  await useBoards.getState().deleteBoard(b.id)
}

const BoardRow = memo(function BoardRow({ b, active }: { b: BoardSummary; active: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const author = useParticipants((s) => s.byId[b.createdBy]?.name)
  const menu = useMenu()
  const hold = useHold((x, y) => menu.openAt({ x, y }))
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (renaming) {
    return (
      <InlineEdit
        className="nx-boards-list__edit"
        initial={b.title}
        label={nt('boards.rename')}
        placeholder={nt('boards.namePlaceholder')}
        onSave={(v) => useBoards.getState().renameBoard(b.id, v)}
        onDone={() => setRenaming(false)}
      />
    )
  }
  return (
    <>
      <a
        href={href({ section: 'boards', id: b.id })}
        onClick={(e) => linkClick(e, { replace: active })}
        className="nx-room"
        aria-current={active ? 'page' : undefined}
        {...hold}
      >
        {active && <motion.span layoutId="nx-boards-sel" className="nx-room__sel" transition={T_FAST} />}
        <span className="nx-room-glyph"><IBoard /></span>
        <span className="nx-room__main">
          <span className="nx-room__top">
            <span className="nx-room__title">{b.title}</span>
            <span className="nx-room__time nx-mono">{listStamp(b.updatedAt, locale)}</span>
          </span>
          <span className="nx-room__bottom">
            <span className="nx-room__preview">{b.description || (author ? nt('boards.by', { name: author }) : '')}</span>
          </span>
        </span>
      </a>
      {error && <p className="nx-boards-error nx-boards-list__note" role="alert">{error}</p>}
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { key: 'rename', label: nt('boards.rename'), icon: <IPencil />, onSelect: () => setRenaming(true) },
          'sep',
          {
            key: 'delete',
            label: nt('boards.deleteBoard'),
            icon: <ITrash />,
            danger: true,
            onSelect: () => {
              setError(null)
              confirmDeleteBoard(b, nt('boards.deleteBoardConfirm', { title: b.title })).catch((e) => setError(errText(e)))
            },
          },
        ]}
      />
    </>
  )
})

/** Board list: the sidebar on wide layouts, the first screen on phones.
 *  Rename and delete sit on the row's long-press / right-click menu. */
export function BoardList({ activeId, load, creating, setCreating, stack }: {
  activeId: string | null
  load: ListLoad
  creating: boolean
  setCreating: (v: boolean) => void
  /** Phones show the empty state here; wide layouts show it beside the list. */
  stack: boolean
}) {
  const nt = useNT()
  const list = useBoards((s) => s.list)

  let body: JSX.Element | null
  if (list.length === 0 && load.status === 'loading') {
    body = (
      <div className="nx-rooms" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="nx-room nx-room--skel">
            <span className="nx-skel" style={{ width: 36, height: 36, borderRadius: 999 }} />
            <span className="nx-room__main">
              <span className="nx-skel" style={{ width: '55%', height: 12 }} />
              <span className="nx-skel" style={{ width: '80%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    )
  } else if (list.length === 0 && load.status === 'error') {
    body = (
      <div className="nx-empty" role="alert">
        <b>{nt('boards.loadFailed')}</b>
        {load.error}
        <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={load.retry}>{nt('boards.retry')}</button>
      </div>
    )
  } else if (list.length === 0) {
    body = creating || !stack ? null : (
      <div className="nx-empty">
        <b>{nt('boards.empty')}</b>
        {nt('boards.emptyBody')}
        <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={() => setCreating(true)}>
          <IPlus />
          {nt('boards.createFirst')}
        </button>
      </div>
    )
  } else {
    body = (
      <div className="nx-rooms">
        {load.status === 'error' && (
          <p className="nx-boards-error nx-boards-list__note" role="alert">
            {nt('boards.loadFailed')}
            <button type="button" className="nx-btn nx-btn--sm" onClick={load.retry}>{nt('boards.retry')}</button>
          </p>
        )}
        {list.map((b) => <BoardRow key={b.id} b={b} active={b.id === activeId} />)}
      </div>
    )
  }

  return (
    <aside className="nx-sidebar nx-boards-list" aria-label={nt('boards.title')}>
      <header className="nx-sidebar__head">
        <h1>{nt('boards.title')}</h1>
        {/* Refresh of a list already on screen: the spinner stays at the header. */}
        {load.status === 'loading' && list.length > 0 && <Spinner label={nt('boards.refreshing')} />}
        <IconButton label={nt('boards.new')} tipPlace="below" ring onClick={() => setCreating(true)}>
          <IPlus />
        </IconButton>
      </header>
      <div className="nx-boards-list__scroll nx-scroll">
        {creating && (
          <InlineEdit
            className="nx-boards-list__edit"
            label={nt('boards.new')}
            placeholder={nt('boards.namePlaceholder')}
            onSave={createBoardAndOpen}
            onDone={() => setCreating(false)}
          />
        )}
        {body}
      </div>
    </aside>
  )
}
