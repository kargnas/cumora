/**
 * Pieces shared by the board list, the kanban and the card sheet: card prose
 * with mention and artifact chips, the @-mention field, the inline title
 * editor and due-date helpers.
 */
import {
  createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBoards } from '@/stores/boards'
import { useCalendar } from '@/stores/calendar'
import { useDocuments } from '@/stores/documents'
import { useParticipants } from '@/stores/participants'
import { useLocale, type Locale } from '@/lib/i18n'
import { isImeComposing } from '@/lib/keyboard'
import { boardDueStatus, localCalendarDay } from '@/lib/board-due-date'
import { useResolvedBoardId, useResolvedCalendarId, useResolvedCardId, useResolvedDocumentId } from '@/lib/useArtifactId'
import type { BoardColumn, Participant } from '@/types'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { href, linkClick, navigate } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { Portal, Spinner } from '../../ui/primitives'
import { IBoard, ICalendar, IClock, IDoc } from '../../ui/icons'

export type Kind = BoardColumn['kind']

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ── Due dates ──────────────────────────────────────────────────────── */

/** The viewer's calendar day. A due date is a plain day with no timezone,
 *  so "today" must be the local day; re-read each minute to roll over at
 *  midnight without a per-second render. */
export function useToday(): string {
  const [day, setDay] = useState(localCalendarDay)
  useEffect(() => {
    const t = window.setInterval(() => setDay(localCalendarDay()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return day
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** "Oct 17" (or "Oct 17, 2027" in another year) for a `YYYY-MM-DD` day,
 *  built from local parts so the day never shifts across timezones. */
function shortDay(day: string, locale: Locale): string {
  const [y, m, d] = day.split('-').map(Number)
  const sameYear = y === new Date().getFullYear()
  const key = `${locale}:${sameYear}`
  let f = dayFormats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
    dayFormats.set(key, f)
  }
  return f.format(new Date(y, m - 1, d))
}

/** Status wording for a due date, or null when the date is just a date. */
export function useDueText(dueOn: string | null, kind: Kind, asOf: string): { status: ReturnType<typeof boardDueStatus>; text: string | null } {
  const nt = useNT()
  const status = boardDueStatus(dueOn, kind, asOf)
  const text = status === 'overdue' ? nt('boards.overdue')
    : status === 'today' ? nt('boards.dueToday')
      : status === 'unclassified' ? nt('boards.pastDue')
        : null
  return { status, text }
}

export function DueChip({ dueOn, kind, asOf }: { dueOn: string; kind: Kind; asOf: string }) {
  const nt = useNT()
  const locale = useLocale()
  const { status, text } = useDueText(dueOn, kind, asOf)
  const day = shortDay(dueOn, locale)
  return (
    <span className="nx-chip nx-boards-due" data-s={status} title={text ? `${text} · ${day}` : nt('boards.due', { date: day })}>
      <IClock />
      {status === 'today' ? nt('boards.today') : day}
      {text && <span className="nx-boards-sr">{text}</span>}
    </span>
  )
}

/** Column status as a small dot: the status decides when a due date counts
 *  as overdue, so it stays visible next to the column name. */
export function KindDot({ kind }: { kind: Kind | undefined }) {
  return <span className="nx-boards-kind" data-kind={kind ?? undefined} aria-hidden />
}

/* ── Prose: @mentions and artifact ids ──────────────────────────────── */

interface Candidate { id: string; label: string; token: string }

type Part =
  | { t: 'text'; v: string }
  | { t: 'doc' | 'board' | 'card' | 'event'; id: string }
  | { t: 'at'; id: string; label: string; known: boolean }

// Same grammar as the classic board renderer: artifact ids need a non-id
// character on both sides, and `@` must not follow a word character.
const TOKEN_RE = /(?<![a-z0-9_])doc_[a-z0-9]+(?![a-z0-9_])|(?<![a-z0-9_-])(?:board|card)-[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9_-])|(?<![a-z0-9-])ce-[a-z0-9-]+|(?<![\w@])@/gi
const LOOSE_AT_RE = /^@([a-z0-9][a-z0-9_-]{0,63})/i

/** Split prose into text, mention and artifact parts. Mentions match known
 *  people by id or by full name (names may contain spaces, which is how the
 *  mention picker inserts them); an unknown `@id` still becomes a dim chip
 *  so the writer's intent survives. */
function parseRich(text: string, people: Candidate[]): Part[] {
  const out: Part[] = []
  const lower = text.toLowerCase()
  const re = new RegExp(TOKEN_RE)
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index
    let end = at + m[0].length
    let part: Part | null = null
    if (m[0] === '@') {
      const known = people.find((c) => lower.startsWith(c.token, at + 1) && !/[a-z0-9_-]/i.test(text[at + 1 + c.token.length] ?? ''))
      const loose = known ? null : LOOSE_AT_RE.exec(text.slice(at))
      if (known) {
        part = { t: 'at', id: known.id, label: known.label, known: true }
        end = at + 1 + known.token.length
      } else if (loose) {
        part = { t: 'at', id: loose[1].toLowerCase(), label: loose[1].toLowerCase(), known: false }
        end = at + loose[0].length
      }
    } else {
      const id = m[0]
      const l = id.toLowerCase()
      part = { t: l.startsWith('doc_') ? 'doc' : l.startsWith('board-') ? 'board' : l.startsWith('card-') ? 'card' : 'event', id }
    }
    if (!part) continue
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    out.push(part)
    last = end
    re.lastIndex = end
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

const MentionCtx = createContext<Candidate[]>([])

/** One mention vocabulary for every card on screen. Rows subscribe to this
 *  context instead of the participant store, whose objects change on every
 *  agent status update. */
export function MentionProvider({ children }: { children: ReactNode }) {
  const keys = useParticipants(useShallow((s) => Object.values(s.byId).filter((p) => !p.departedAt).map((p) => `${p.id}\n${p.name}`)))
  const people = useMemo(() => {
    const out: Candidate[] = []
    for (const key of keys) {
      const [id, name] = key.split('\n')
      out.push({ id, label: name, token: id.toLowerCase() })
      if (name.trim()) out.push({ id, label: name, token: name.trim().toLowerCase() })
    }
    // Longest first, so "@Ada Lovelace" wins over "@Ada".
    return out.sort((a, b) => b.token.length - a.token.length)
  }, [keys])
  return <MentionCtx.Provider value={people}>{children}</MentionCtx.Provider>
}

/** Card prose with chips. `quiet` keeps the chips out of the tab order on
 *  card tiles, where the tile itself is the focus stop. */
export const RichText = memo(function RichText({ text, quiet = false }: { text: string; quiet?: boolean }) {
  const people = useContext(MentionCtx)
  const parts = useMemo(() => parseRich(text, people), [text, people])
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === 'text') return p.v
        if (p.t === 'at') return <span key={i} className="nx-boards-at" data-known={p.known || undefined} title={`@${p.id}`}>@{p.label}</span>
        if (p.t === 'doc') return <DocChip key={i} raw={p.id} quiet={quiet} />
        if (p.t === 'board') return <BoardChip key={i} raw={p.id} quiet={quiet} />
        if (p.t === 'card') return <CardChip key={i} raw={p.id} quiet={quiet} />
        return <EventChip key={i} raw={p.id} quiet={quiet} />
      })}
    </>
  )
})

function Chip({ to, onOpen, icon, label, title, quiet }: {
  to?: string
  onOpen?: () => void
  icon: ReactNode
  label: string
  title: string
  quiet: boolean
}) {
  // stopPropagation: chips sit inside clickable cards, and following a link
  // must not also open the card underneath.
  const common = { className: 'nx-boards-ref', title, 'aria-label': title, tabIndex: quiet ? -1 : undefined, draggable: false }
  const body = <>{icon}<span>{label}</span></>
  return to
    ? <a {...common} href={to} onClick={(e) => { e.stopPropagation(); linkClick(e) }}>{body}</a>
    : <button {...common} type="button" onClick={(e) => { e.stopPropagation(); onOpen?.() }}>{body}</button>
}

function DocChip({ raw, quiet }: { raw: string; quiet: boolean }) {
  const nt = useNT()
  const id = useResolvedDocumentId(raw)
  const label = useDocuments((s) => s.list.find((d) => d.id === id)?.title?.trim()) || id
  return <Chip to={href({ section: 'docs', id })} icon={<IDoc />} label={label} title={nt('boards.openDoc', { title: label })} quiet={quiet} />
}

function BoardChip({ raw, quiet }: { raw: string; quiet: boolean }) {
  const nt = useNT()
  const id = useResolvedBoardId(raw)
  const label = useBoards((s) => s.list.find((b) => b.id === id)?.title?.trim()) || id
  return <Chip to={href({ section: 'boards', id })} icon={<IBoard />} label={label} title={nt('boards.openBoard', { title: label })} quiet={quiet} />
}

function CardChip({ raw, quiet }: { raw: string; quiet: boolean }) {
  const nt = useNT()
  const id = useResolvedCardId(raw)
  // "boardId\ntitle" keeps the selector's result a primitive.
  const local = useBoards((s) => {
    for (const snap of Object.values(s.snapshots)) {
      const c = snap.cards.find((x) => x.id === id)
      if (c) return `${snap.id}\n${c.title}`
    }
    const l = s.cardLookups[id]
    return l ? `${l.board.id}\n${l.card.title}` : null
  })
  const asked = useRef(false)
  useEffect(() => {
    if (local || asked.current) return
    asked.current = true
    void useBoards.getState().loadCard(id).catch(() => { /* stale reference: the chip keeps the raw id */ })
  }, [id, local])
  const [boardId, title] = local ? local.split('\n') : [null, null]
  const label = title?.trim() || id
  const open = () => {
    void useBoards.getState().loadCard(id)
      .then((l) => navigate(href({ section: 'boards', id: l.board.id, params: { card: l.card.id } })))
      .catch(() => { /* nothing to open */ })
  }
  return (
    <Chip
      to={boardId ? href({ section: 'boards', id: boardId, params: { card: id } }) : undefined}
      onOpen={open}
      icon={<IBoard />}
      label={label}
      title={nt('boards.openCard', { title: label })}
      quiet={quiet}
    />
  )
}

function EventChip({ raw, quiet }: { raw: string; quiet: boolean }) {
  const nt = useNT()
  const id = useResolvedCalendarId(raw)
  const title = useCalendar((s) => s.events.find((e) => e.id === id)?.title?.trim())
  const asked = useRef(false)
  useEffect(() => {
    if (title || asked.current) return
    asked.current = true
    void useCalendar.getState().loadEvent(id).catch(() => { /* stale reference */ })
  }, [id, title])
  const label = title || id
  return <Chip to={href({ section: 'calendar', id })} icon={<ICalendar />} label={label} title={nt('boards.openEvent', { title: label })} quiet={quiet} />
}

/* ── @-mention field ────────────────────────────────────────────────── */

const NOBODY: Participant[] = []
type Field = HTMLTextAreaElement & HTMLInputElement

interface MentionFieldProps {
  value: string
  onChange: (v: string) => void
  label: string
  placeholder: string
  multiline?: boolean
  /** Multiline only: plain Enter submits and Shift+Enter breaks the line.
   *  Without it a multiline field submits on Cmd/Ctrl+Enter. */
  enterSubmits?: boolean
  onSubmit?: (el: Field) => void
  onCancel?: (el: Field) => void
  onFocus?: () => void
  onBlur?: () => void
  autoFocus?: boolean
  readOnly?: boolean
  rows?: number
  className?: string
}

/** Text field with an `@` picker: typing `@` plus letters lists matching
 *  people, arrows move, Enter or Tab inserts `@Name `. The list floats in
 *  the layer root so a scrolling column or sheet never clips it. */
export function MentionField(props: MentionFieldProps) {
  const nt = useNT()
  const ref = useRef<Field>(null)
  const listId = useId()
  const [pick, setPick] = useState<{ start: number; query: string } | null>(null)
  const [hi, setHi] = useState(0)
  const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null)
  const query = pick?.query.toLowerCase() ?? null
  const matches = useParticipants(useShallow((s) => (query === null ? NOBODY : Object.values(s.byId)
    .filter((p) => !p.departedAt && (p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query)))
    .slice(0, 6))))

  useLayoutEffect(() => {
    if (!pick || !ref.current) { setBox(null); return }
    const r = ref.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom > 240 || r.top < 240
    setBox({ left: r.left, width: Math.min(320, Math.max(240, r.width)), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) })
  }, [pick])

  /** An open `@token` right before the caret: `@` at the start or after
   *  whitespace or an opening bracket, then id characters only. */
  const detect = (text: string, caret: number) => {
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i]
      if (ch === '@') {
        const prev = text[i - 1]
        const token = text.slice(i + 1, caret)
        if ((!prev || /[\s([]/.test(prev)) && /^[a-z0-9_-]*$/i.test(token)) {
          setPick({ start: i, query: token })
          setHi(0)
          return
        }
        break
      }
      if (!/[a-z0-9_-]/i.test(ch)) break
    }
    setPick(null)
  }

  const insert = (p: Participant) => {
    const el = ref.current
    if (!el || !pick) return
    const caret = el.selectionStart ?? props.value.length
    const before = props.value.slice(0, pick.start)
    const token = `@${p.name.trim() || p.id} `
    props.onChange(before + token + props.value.slice(caret))
    setPick(null)
    requestAnimationFrame(() => {
      const pos = before.length + token.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const onKeyDown = (e: KeyboardEvent<Field>) => {
    if (isImeComposing(e)) return
    const open = pick !== null && matches.length > 0
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault()
      insert(matches[hi] ?? matches[0])
      return
    }
    if (e.key === 'Escape') {
      // preventDefault also tells the card sheet not to close on this Escape.
      if (open) { e.preventDefault(); setPick(null); return }
      if (props.onCancel) { e.preventDefault(); props.onCancel(e.currentTarget) }
      return
    }
    if (e.key === 'Enter' && props.onSubmit) {
      const submit = !props.multiline || (props.enterSubmits ? !e.shiftKey : e.metaKey || e.ctrlKey)
      if (submit) { e.preventDefault(); props.onSubmit(e.currentTarget) }
    }
  }

  const common = {
    ref,
    value: props.value,
    placeholder: props.placeholder,
    'aria-label': props.label,
    'aria-autocomplete': 'list' as const,
    'aria-controls': pick ? listId : undefined,
    'aria-activedescendant': pick && matches[hi] ? `${listId}-${hi}` : undefined,
    autoFocus: props.autoFocus,
    readOnly: props.readOnly,
    'aria-busy': props.readOnly || undefined,
    className: props.className ? `nx-input ${props.className}` : 'nx-input',
    onChange: (e: React.ChangeEvent<Field>) => {
      props.onChange(e.target.value)
      detect(e.target.value, e.target.selectionStart ?? e.target.value.length)
    },
    onKeyDown,
    onFocus: props.onFocus,
    onBlur: () => { setPick(null); props.onBlur?.() },
  }
  return (
    <>
      {props.multiline ? <textarea {...common} rows={props.rows ?? 3} /> : <input {...common} />}
      {pick && matches.length > 0 && box && (
        <Portal>
          <div
            id={listId}
            role="listbox"
            aria-label={nt('boards.mention')}
            className="nx-boards-mentions"
            style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom }}
          >
            {matches.map((p, i) => (
              <button
                key={p.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === hi}
                data-highlighted={i === hi || undefined}
                className="nx-menu__item"
                // Keep focus (and the phone keyboard) in the field.
                onPointerDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => insert(p)}
              >
                <Avatar p={p} size={20} />
                <span>{p.name}</span>
                <span className="nx-boards-mentions__sub">{p.role ?? (p.kind === 'agent' ? nt('boards.agent') : nt('boards.teammate'))}</span>
              </button>
            ))}
          </div>
        </Portal>
      )}
    </>
  )
}

/* ── Inline title editor ────────────────────────────────────────────── */

/** One-line editor for names (new board, rename, new column). Enter or blur
 *  saves, Escape cancels; the field stays up with the error if saving fails. */
export function InlineEdit({ initial = '', label, placeholder, onSave, onDone, className }: {
  initial?: string
  label: string
  placeholder: string
  onSave: (value: string) => Promise<unknown>
  onDone: () => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closed = useRef(false)
  const close = () => {
    if (closed.current) return
    closed.current = true
    onDone()
  }
  const commit = async () => {
    if (busy || closed.current) return
    const v = value.trim()
    if (!v || v === initial.trim()) { close(); return }
    setBusy(true)
    setError(null)
    try {
      await onSave(v)
      haptic('success')
      close()
    } catch (e) {
      haptic('error')
      setError(errText(e))
      setBusy(false)
    }
  }
  return (
    <div className={className ? `nx-boards-edit ${className}` : 'nx-boards-edit'}>
      <div className="nx-boards-edit__row">
        <input
          className="nx-input"
          // The field only appears because the user just asked to type a name.
          autoFocus
          value={value}
          readOnly={busy}
          aria-busy={busy || undefined}
          aria-invalid={error ? true : undefined}
          aria-label={label}
          placeholder={placeholder}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') { e.preventDefault(); void commit() }
            if (e.key === 'Escape') { e.preventDefault(); close() }
          }}
          onBlur={() => void commit()}
        />
        {busy && <Spinner />}
      </div>
      {error && <span className="nx-boards-error" role="alert">{error}</span>}
    </div>
  )
}
