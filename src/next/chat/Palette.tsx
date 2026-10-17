/**
 * ⌘K switcher. Rooms and people match locally on every keystroke, so the
 * list never waits on the network; message hits from the server search fill
 * in underneath once the query settles.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api, type ApiSearchResults } from '@/api/client'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { isImeComposing } from '@/lib/keyboard'
import { useNT } from '../i18n'
import { href, navigate } from '../router'
import { useOpenDirect } from '../hooks'
import { Avatar } from '../ui/Avatar'
import { RoomGlyph } from './Sidebar'
import { Kbd, MOD, Portal, Spinner, T_FAST, useCoarse } from '../ui/primitives'
import { ISearch } from '../ui/icons'

type Item = { key: string; group: string; icon: ReactNode; title: string; sub?: string; run: () => void }

export function Palette() {
  const nt = useNT()
  const coarse = useCoarse()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'all' | 'people'>('all')
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [remote, setRemote] = useState<ApiSearchResults['messages']>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const me = useMe()
  const list = useConversations((s) => s.list)
  const byId = useParticipants((s) => s.byId)
  const openDirect = useOpenDirect()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setMode('all')
        setOpen((v) => !v)
      }
    }
    const onOpen = (e: Event) => {
      setMode((e as CustomEvent<'all' | 'people'>).detail ?? 'all')
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('nx:palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('nx:palette', onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) { setQ(''); setRemote([]); setHi(0); return }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Server message search, debounced and cancelled when the query moves on.
  useEffect(() => {
    const query = q.trim()
    if (!open || mode !== 'all' || query.length < 2) { setRemote([]); setSearching(false); return }
    const ctrl = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      api.search(query, ctrl.signal)
        .then((r) => setRemote(r.messages.slice(0, 8)))
        .catch(() => { /* aborted or offline: local results still stand */ })
        .finally(() => { if (!ctrl.signal.aborted) setSearching(false) })
    }, 220)
    return () => { ctrl.abort(); window.clearTimeout(timer) }
  }, [q, open, mode])

  const close = () => setOpen(false)

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase()
    const out: Item[] = []
    if (mode === 'all') {
      const rooms = list
        .filter((c) => c.kind !== 'whisper' && (!query || c.title.toLowerCase().includes(query)))
        .slice(0, query ? 8 : 6)
      for (const c of rooms) {
        out.push({
          key: `c-${c.id}`,
          group: query ? nt('palette.rooms') : nt('palette.recent'),
          icon: <RoomGlyph c={c} size={28} />,
          title: c.title,
          sub: c.preview,
          run: () => navigate(href({ section: 'chats', id: c.id })),
        })
      }
    }
    if (query || mode === 'people') {
      const people = Object.values(byId)
        .filter((p) => p.id !== me && !p.departedAt && (!query || p.name.toLowerCase().includes(query) || (p.role ?? '').toLowerCase().includes(query)))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'agent' ? -1 : 1))
        .slice(0, mode === 'people' ? 20 : 6)
      for (const p of people) {
        out.push({
          key: `p-${p.id}`,
          group: nt('palette.people'),
          icon: <Avatar p={p} size={28} presence />,
          title: p.name,
          sub: p.role ?? undefined,
          run: () => void openDirect(p.id),
        })
      }
    }
    for (const m of remote) {
      out.push({
        key: `m-${m.id}`,
        group: nt('palette.messages'),
        icon: <span className="nx-room-glyph"><ISearch /></span>,
        title: m.snippet,
        sub: `${m.authorName ?? ''} · ${m.conversationTitle}`,
        run: () => {
          navigate(href({ section: 'chats', id: m.conversationId }))
          // ChatView consumes this once the transcript is mounted.
          useApp.getState().jumpToMessage(m.id)
        },
      })
    }
    return out
  }, [q, mode, list, byId, me, remote, nt, openDirect])

  useEffect(() => { setHi(0) }, [q, mode])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(items.length - 1, i + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)) }
    if (e.key === 'Enter' && items[hi]) { e.preventDefault(); items[hi].run(); close() }
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  let lastGroup = ''
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <div className="nx-layer nx-palette-layer">
            <motion.div className="nx-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T_FAST} onClick={close} />
            <motion.div
              className="nx-palette"
              role="dialog"
              aria-modal="true"
              aria-label={nt('palette.label')}
              initial={coarse ? { y: 24, opacity: 0 } : { opacity: 0, scale: 0.98, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={coarse ? { y: 24, opacity: 0 } : { opacity: 0, scale: 0.98, y: -8 }}
              transition={T_FAST}
            >
              <div className="nx-palette__field">
                <ISearch aria-hidden />
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={mode === 'people' ? nt('palette.peoplePlaceholder') : nt('palette.placeholder')}
                  aria-label={nt('palette.label')}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="nx-palette-list"
                  aria-activedescendant={items[hi] ? `nx-pi-${hi}` : undefined}
                  enterKeyHint="go"
                />
                {searching && <Spinner />}
                {!coarse && <Kbd>esc</Kbd>}
              </div>
              <div ref={listRef} id="nx-palette-list" className="nx-palette__list nx-scroll" role="listbox">
                {items.length === 0 && (
                  <div className="nx-empty">{q.trim() ? nt('palette.none') : nt('palette.hint', { mod: MOD })}</div>
                )}
                {items.map((it, i) => {
                  const head = it.group !== lastGroup
                  lastGroup = it.group
                  return (
                    <div key={it.key}>
                      {head && <div className="nx-group-label">{it.group}</div>}
                      <button
                        type="button"
                        id={`nx-pi-${i}`}
                        data-i={i}
                        role="option"
                        aria-selected={i === hi}
                        className="nx-palette__item"
                        onMouseMove={() => setHi(i)}
                        onClick={() => { it.run(); close() }}
                      >
                        {it.icon}
                        <span className="nx-palette__text">
                          <span className="nx-palette__title">{it.title}</span>
                          {it.sub && <span className="nx-palette__sub">{it.sub}</span>}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  )
}
