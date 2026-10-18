/**
 * Card detail: a docked panel on `full`, a sheet over the board on `split`,
 * a pushed screen on `stack`. Fields save in place (title on blur or Enter,
 * column and assignee on pick, due date on change) and each shows its own
 * pending state; comments update live from `board.changed` events.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, ws } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { BoardCard, BoardCardComment, BoardColumn, Participant } from '@/types'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { listStamp } from '../../format'
import type { Layout } from '../../layout'
import { Avatar } from '../../ui/Avatar'
import { IconButton, Kbd, MOD, Menu, Spinner, useCoarse, useMenu, type MenuEntry } from '../../ui/primitives'
import { ICheck, IChevronDown, IChevronLeft, IPencil, IPlus, ITrash, IX } from '../../ui/icons'
import { cardsIn } from './drag'
import { KindDot, MentionField, RichText, errText, useDueText, useToday } from './parts'

const NO_COLUMNS: BoardColumn[] = []
const NO_COMMENTS: BoardCardComment[] = []

/** Escape closes the sheet unless something on top (menu, dialog, an
 *  edit that handled the key) took it first. */
function useEscape(onClose: () => void): void {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('#nx-layers .nx-layer')) return
      cb.current()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
}

/* ── Title ──────────────────────────────────────────────────────────── */

function TitleField({ boardId, card }: { boardId: string; card: BoardCard }) {
  const nt = useNT()
  const [draft, setDraft] = useState(card.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const focused = useRef(false)
  const skip = useRef(false)
  // Someone else renamed the card: follow, unless the field is being edited.
  useEffect(() => { if (!focused.current) setDraft(card.title) }, [card.title])
  const save = async () => {
    const next = draft.trim()
    if (!next) { setDraft(card.title); return }
    if (next === card.title) return
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().patchCard(boardId, card.id, { title: next })
    } catch (e) {
      setError(errText(e))
      setDraft(card.title)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nx-boards-title">
      <MentionField
        multiline
        enterSubmits
        // field-sizing: content grows the field to fit; WebKit before 26.2
        // ignores it and keeps two rows.
        rows={2}
        className="nx-boards-title__input"
        value={draft}
        onChange={setDraft}
        label={nt('boards.titleLabel')}
        placeholder={nt('boards.titlePlaceholder')}
        onFocus={() => { focused.current = true }}
        onSubmit={(el) => el.blur()}
        onCancel={(el) => {
          skip.current = true
          setDraft(card.title)
          el.blur()
        }}
        onBlur={() => {
          focused.current = false
          if (skip.current) { skip.current = false; return }
          void save()
        }}
      />
      {busy && <Spinner label={nt('boards.titleLabel')} />}
      {error && <span className="nx-boards-error" role="alert">{error}</span>}
    </div>
  )
}

/* ── Properties ─────────────────────────────────────────────────────── */

function ColumnRow({ boardId, card }: { boardId: string; card: BoardCard }) {
  const nt = useNT()
  const columns = useBoards((s) => s.snapshots[boardId]?.columns ?? NO_COLUMNS)
  const menu = useMenu()
  const current = columns.find((c) => c.id === card.columnId)
  const entries: MenuEntry[] = columns.map((col) => ({
    key: col.id,
    label: col.title,
    icon: col.id === card.columnId ? <ICheck /> : <KindDot kind={col.kind} />,
    // To the end of the column, like dropping a card onto it; the checked
    // current column is a no-op.
    onSelect: () => {
      if (col.id === card.columnId) return
      void useBoards.getState().moveCardOptimistic(boardId, card.id, col.id, cardsIn(useBoards.getState().snapshots[boardId], col.id).length)
    },
  }))
  return (
    <div className="nx-row">
      <span className="nx-row__text">{nt('boards.column')}</span>
      <button
        type="button"
        className="nx-btn nx-btn--sm nx-boards-value"
        aria-haspopup="menu"
        aria-label={nt('boards.columnValue', { value: current?.title ?? '' })}
        onClick={(e) => menu.toggleFrom(e.currentTarget, 'end')}
      >
        <KindDot kind={current?.kind} />
        <span className="nx-boards-value__text">{current?.title}</span>
        <IChevronDown />
      </button>
      <Menu open={menu.open} anchor={menu.anchor} onClose={menu.close} entries={[{ label: nt('boards.moveTo') }, ...entries]} />
    </div>
  )
}

const NO_ONE: Record<string, Participant> = {}

function AssigneeRow({ boardId, card }: { boardId: string; card: BoardCard }) {
  const nt = useNT()
  const me = useMe()
  const coarse = useCoarse()
  const listId = useId()
  const menu = useMenu()
  const assignee = useParticipants((s) => (card.assigneeId ? s.byId[card.assigneeId] : undefined))
  // The roster only while the picker is open: presence updates rewrite
  // participant objects all the time and would re-render a closed row.
  const byId = useParticipants((s) => (menu.open ? s.byId : NO_ONE))
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = useMemo(() => {
    // Me first, then teammates, then agents, each by name (classic order).
    const people = Object.values(byId).filter((p) => !p.departedAt).sort((a, b) => {
      if (a.id === me) return -1
      if (b.id === me) return 1
      if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const q = query.trim().toLowerCase()
    return q
      ? people.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      : [null, ...people]
  }, [byId, me, query])

  const choose = async (id: string | null) => {
    menu.close()
    if (id === card.assigneeId) return
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().patchCard(boardId, card.id, { assigneeId: id })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const meta = (p: Participant) => (p.id === me ? nt('boards.you') : p.kind === 'agent' ? (p.role ?? nt('boards.agent')) : nt('boards.teammate'))

  return (
    <div className="nx-row">
      <span className="nx-row__text">
        <span>{nt('boards.assignee')}</span>
        {error && <span className="nx-boards-error" role="alert">{error}</span>}
      </span>
      {busy && <Spinner label={nt('boards.assignee')} />}
      <button
        type="button"
        className="nx-btn nx-btn--sm nx-boards-value"
        aria-haspopup="listbox"
        aria-label={nt('boards.assigneeValue', { value: assignee?.name ?? nt('boards.unassigned') })}
        onClick={(e) => {
          setQuery('')
          setHi(0)
          menu.toggleFrom(e.currentTarget, 'end')
        }}
      >
        {assignee && <Avatar p={assignee} size={20} />}
        <span className="nx-boards-value__text">{assignee?.name ?? nt('boards.unassigned')}</span>
        <IChevronDown />
      </button>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[]}
        header={(
          <div className="nx-boards-picker">
            <input
              className="nx-input"
              // A phone keyboard would cover half the sheet; there you scroll and tap.
              autoFocus={!coarse}
              value={query}
              placeholder={nt('boards.searchPeople')}
              aria-label={nt('boards.searchPeople')}
              aria-controls={listId}
              aria-activedescendant={options[hi] !== undefined ? `${listId}-${hi}` : undefined}
              onChange={(e) => { setQuery(e.target.value); setHi(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (options.length) setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
                } else if (e.key === 'Enter' && options[hi] !== undefined) {
                  e.preventDefault()
                  void choose(options[hi]?.id ?? null)
                }
              }}
            />
            <div id={listId} role="listbox" aria-label={nt('boards.assignee')} className="nx-boards-picker__list nx-scroll">
              {options.map((p, i) => (
                <button
                  key={p?.id ?? 'none'}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={(p?.id ?? null) === card.assigneeId}
                  data-highlighted={i === hi || undefined}
                  className="nx-menu__item"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => void choose(p?.id ?? null)}
                >
                  {p ? <Avatar p={p} size={20} /> : <span className="nx-boards-picker__none" aria-hidden />}
                  <span className="nx-boards-picker__name">{p ? p.name : nt('boards.unassigned')}</span>
                  {p && <span className="nx-boards-picker__meta">{meta(p)}</span>}
                  {(p?.id ?? null) === card.assigneeId && <ICheck />}
                </button>
              ))}
              {options.length === 0 && <p className="nx-boards-picker__empty">{nt('boards.noMatch')}</p>}
            </div>
          </div>
        )}
      />
    </div>
  )
}

function DueRow({ boardId, card }: { boardId: string; card: BoardCard }) {
  const nt = useNT()
  const asOf = useToday()
  const kind = useBoards((s) => s.snapshots[boardId]?.columns.find((c) => c.id === card.columnId)?.kind ?? null)
  const { status, text } = useDueText(card.dueOn, kind, asOf)
  // Local draft: a native date field passes through partial years while
  // someone types one, and a controlled value would snap those back.
  const [draft, setDraft] = useState(card.dueOn ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => setDraft(card.dueOn ?? ''), [card.dueOn])
  const save = async (dueOn: string | null) => {
    if (dueOn === card.dueOn) return
    setBusy(true)
    setFailed(false)
    try {
      await useBoards.getState().patchCard(boardId, card.id, { dueOn })
    } catch {
      setFailed(true)
      setDraft(card.dueOn ?? '')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nx-row">
      <span className="nx-row__text">
        <span>{nt('boards.dueDate')}</span>
        {text && <span className="nx-boards-due nx-boards-due--text" data-s={status}>{text}</span>}
        {failed && <span className="nx-boards-error" role="alert">{nt('boards.dueFailed')}</span>}
      </span>
      {busy && <Spinner label={nt('boards.dueDate')} />}
      <input
        type="date"
        className="nx-input nx-boards-date"
        value={draft}
        aria-label={nt('boards.dueDate')}
        onChange={(e) => {
          const v = e.target.value
          setDraft(v)
          // Save complete dates only; "0002-…" is a year still being typed.
          if (!v) void save(null)
          else if (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900) void save(v)
        }}
      />
      {card.dueOn && (
        <IconButton small label={nt('boards.clearDue')} onClick={() => { setDraft(''); void save(null) }}><IX /></IconButton>
      )}
    </div>
  )
}

/* ── Description ────────────────────────────────────────────────────── */

function Description({ boardId, card }: { boardId: string; card: BoardCard }) {
  const nt = useNT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const begin = () => {
    setDraft(card.description ?? '')
    setError(null)
    setEditing(true)
  }
  const save = async () => {
    const next = draft.trim()
    if (next === (card.description ?? '').trim()) { setEditing(false); return }
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().patchCard(boardId, card.id, { description: next })
      haptic('success')
      setEditing(false)
    } catch (e) {
      haptic('error')
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="nx-boards-block">
      <div className="nx-boards-block__head">
        <h3>{nt('boards.description')}</h3>
        {busy && <Spinner label={nt('boards.description')} />}
        {!editing && card.description && (
          <IconButton small label={nt('boards.editDescription')} onClick={begin}><IPencil /></IconButton>
        )}
      </div>
      {editing ? (
        <>
          <MentionField
            multiline
            rows={5}
            autoFocus
            value={draft}
            onChange={setDraft}
            readOnly={busy}
            label={nt('boards.description')}
            placeholder={nt('boards.descPlaceholder')}
            onSubmit={() => void save()}
            onCancel={() => setEditing(false)}
          />
          {error && <span className="nx-boards-error" role="alert">{error}</span>}
          <div className="nx-boards-actions">
            <Kbd>{MOD}↵</Kbd>
            <button type="button" className="nx-btn nx-btn--sm" onClick={() => setEditing(false)}>{nt('boards.cancel')}</button>
            <button type="button" className="nx-btn nx-btn--sm nx-btn--primary" disabled={busy} onClick={() => void save()}>{nt('boards.save')}</button>
          </div>
        </>
      ) : card.description ? (
        <p className="nx-boards-prose"><RichText text={card.description} /></p>
      ) : (
        <button type="button" className="nx-btn nx-btn--sm nx-boards-add" onClick={begin}>
          <IPlus />
          {nt('boards.addDescription')}
        </button>
      )}
    </section>
  )
}

/* ── Comments ───────────────────────────────────────────────────────── */

const CommentRow = memo(function CommentRow({ boardId, cardId, c }: { boardId: string; cardId: string; c: BoardCardComment }) {
  const nt = useNT()
  const locale = useLocale()
  const me = useMe()
  const author = useParticipants((s) => s.byId[c.authorId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (!window.confirm(nt('boards.deleteCommentConfirm'))) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteCardComment(boardId, cardId, c.id)
      // The list and the card's comment count both change.
      await Promise.all([useBoards.getState().loadComments(boardId, cardId), useBoards.getState().refreshBoard(boardId)])
      haptic('success')
    } catch (e) {
      haptic('error')
      setError(errText(e))
      setBusy(false)
    }
  }
  return (
    <li className="nx-boards-comment">
      {author ? <Avatar p={author} size={24} /> : <span className="nx-boards-comment__blank" aria-hidden />}
      <div className="nx-boards-comment__main">
        <div className="nx-boards-comment__top">
          <b>{author?.name ?? c.authorId}</b>
          <time className="nx-mono" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString(locale)}>{listStamp(c.createdAt, locale)}</time>
          {/* The server lets authors delete only their own comments. */}
          {c.authorId === me && (
            <IconButton small className="nx-boards-comment__del" label={nt('boards.deleteComment')} disabled={busy} onClick={() => void remove()}>
              {busy ? <Spinner /> : <ITrash />}
            </IconButton>
          )}
        </div>
        <p className="nx-boards-prose"><RichText text={c.body} /></p>
        {error && <span className="nx-boards-error" role="alert">{error}</span>}
      </div>
    </li>
  )
})

function CommentComposer({ boardId, cardId }: { boardId: string; cardId: string }) {
  const nt = useNT()
  const coarse = useCoarse()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const post = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().addComment(boardId, cardId, body)
      haptic('success')
      setDraft('')
    } catch (e) {
      haptic('error')
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nx-boards-composer">
      <MentionField
        multiline
        rows={2}
        value={draft}
        onChange={setDraft}
        readOnly={busy}
        label={nt('boards.commentLabel')}
        placeholder={nt('boards.commentPlaceholder')}
        onSubmit={() => void post()}
      />
      {error && <span className="nx-boards-error" role="alert">{error}</span>}
      <div className="nx-boards-actions">
        {!coarse && <Kbd>{MOD}↵</Kbd>}
        <button type="button" className="nx-btn nx-btn--sm nx-btn--primary" disabled={!draft.trim() || busy} onClick={() => void post()}>
          {busy && <Spinner />}
          {nt('boards.comment')}
        </button>
      </div>
    </div>
  )
}

function Comments({ boardId, cardId }: { boardId: string; cardId: string }) {
  const nt = useNT()
  const cached = useBoards((s) => s.comments[cardId])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const load = useCallback(() => {
    setStatus('loading')
    useBoards.getState().loadComments(boardId, cardId).then(() => setStatus('ready'), () => setStatus('error'))
  }, [boardId, cardId])
  useEffect(load, [load])
  // The store refreshes the board on comment events but not the comment
  // list, so an open card reloads its own list when one lands.
  useEffect(() => ws.on((ev) => {
    if (ev.type !== 'board.changed' || ev.cardId !== cardId || !ev.kind.startsWith('comment.')) return
    useBoards.getState().loadComments(boardId, cardId).catch(() => { /* the next event or reopen retries */ })
  }), [boardId, cardId])
  const comments = cached ?? NO_COMMENTS

  let body: JSX.Element
  if (!cached && status === 'loading') {
    body = (
      <div className="nx-boards-comments" aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className="nx-boards-comment">
            <span className="nx-skel" style={{ width: 24, height: 24, borderRadius: 999 }} />
            <span className="nx-boards-comment__main">
              <span className="nx-skel" style={{ width: '40%', height: 10 }} />
              <span className="nx-skel" style={{ width: '90%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    )
  } else if (!cached && status === 'error') {
    body = (
      <div className="nx-boards-inline-error" role="alert">
        <span>{nt('boards.commentsFailed')}</span>
        <button type="button" className="nx-btn nx-btn--sm nx-btn--outline" onClick={load}>{nt('boards.retry')}</button>
      </div>
    )
  } else if (comments.length === 0) {
    body = <p className="nx-boards-muted">{nt('boards.noComments')}</p>
  } else {
    body = <ol className="nx-boards-comments">{comments.map((c) => <CommentRow key={c.id} boardId={boardId} cardId={cardId} c={c} />)}</ol>
  }

  return (
    <section className="nx-boards-block">
      <div className="nx-boards-block__head">
        <h3>{nt('boards.comments')}</h3>
        {comments.length > 0 && <span className="nx-badge nx-badge--muted">{comments.length}</span>}
        {cached && status === 'loading' && <Spinner label={nt('boards.comments')} />}
      </div>
      {body}
      <CommentComposer boardId={boardId} cardId={cardId} />
    </section>
  )
}

/* ── Sheet ──────────────────────────────────────────────────────────── */

function DeleteCard({ boardId, card, onClose }: { boardId: string; card: BoardCard; onClose: () => void }) {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (!window.confirm(nt('boards.deleteCardConfirm', { title: card.title }))) return
    setBusy(true)
    setError(null)
    try {
      await useBoards.getState().deleteCard(boardId, card.id)
      haptic('success')
      onClose()
    } catch (e) {
      haptic('error')
      setError(errText(e))
      setBusy(false)
    }
  }
  return (
    <>
      {error && <span className="nx-boards-error" role="alert">{error}</span>}
      <IconButton label={nt('boards.deleteCard')} tipPlace="below" disabled={busy} onClick={() => void remove()}>
        {busy ? <Spinner /> : <ITrash />}
      </IconButton>
    </>
  )
}

export function CardSheet({ boardId, cardId, layout, onClose }: {
  boardId: string
  cardId: string
  layout: Layout
  onClose: () => void
}) {
  const nt = useNT()
  const locale = useLocale()
  const card = useBoards((s) => s.snapshots[boardId]?.cards.find((c) => c.id === cardId))
  const hasSnap = useBoards((s) => Boolean(s.snapshots[boardId]))
  const column = useBoards((s) => (card ? s.snapshots[boardId]?.columns.find((c) => c.id === card.columnId) : undefined))
  const author = useParticipants((s) => (card ? s.byId[card.createdBy]?.name : undefined))
  const ref = useRef<HTMLElement>(null)
  useEscape(onClose)
  // Over the board (sheet or pushed screen) focus moves in; docked, it stays
  // on the board so arrowing through cards keeps working.
  useEffect(() => { if (layout !== 'full') ref.current?.focus() }, [layout])

  return (
    <section ref={ref} tabIndex={-1} className="nx-boards-sheet" aria-label={card?.title ?? nt('boards.card')}>
      <header className="nx-boards-sheet__head">
        {layout === 'stack' && (
          <IconButton label={nt('boards.backToBoard')} onClick={onClose}><IChevronLeft /></IconButton>
        )}
        <span className="nx-boards-sheet__crumb">
          {column && <KindDot kind={column.kind} />}
          <span>{column?.title ?? nt('boards.card')}</span>
        </span>
        {card && <DeleteCard boardId={boardId} card={card} onClose={onClose} />}
        {layout !== 'stack' && (
          <IconButton label={nt('boards.close')} tipPlace="below" onClick={onClose}><IX /></IconButton>
        )}
      </header>
      {!hasSnap ? (
        <div className="nx-center" aria-busy="true"><Spinner large label={nt('boards.loadingCard')} /></div>
      ) : !card ? (
        <div className="nx-empty nx-boards-fill">
          <b>{nt('boards.unavailable')}</b>
          {nt('boards.unavailableBody')}
        </div>
      ) : (
        <div className="nx-boards-sheet__body nx-scroll">
          <TitleField boardId={boardId} card={card} />
          <div className="nx-rows">
            <ColumnRow boardId={boardId} card={card} />
            <AssigneeRow boardId={boardId} card={card} />
            <DueRow boardId={boardId} card={card} />
          </div>
          <Description boardId={boardId} card={card} />
          <Comments boardId={boardId} cardId={card.id} />
          <p className="nx-boards-meta">{nt('boards.created', { when: listStamp(card.createdAt, locale), name: author ?? card.createdBy })}</p>
        </div>
      )}
    </section>
  )
}
