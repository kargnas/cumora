/**
 * Round composer. Text editing, mention chips and Skype emoticons come from
 * the classic RichInput; drafts live in useApp.composerDrafts (mirrored to
 * localStorage), so a half-typed message survives switching rooms, sections
 * or reloading, exactly like the classic shells.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api, type ApiAttachment } from '@/api/client'
import { useApp } from '@/stores/app'
import { EMPTY_DRAFT, type ComposerDraft } from '@/stores/composerDrafts'
import { useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useMessages, sendUserMessage } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { RichInput, type RichInputHandle } from '@/components/RichInput'
import { PollComposer } from '@/components/PollComposer'
import { isImeComposing } from '@/lib/keyboard'
import { useAgentStop } from '@/lib/agentStop'
import type { Participant } from '@/types'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { authorOf } from './deletedAuthor'
import { Avatar } from '../ui/Avatar'
import { IconButton, Kbd, Menu, Spinner, T_QUICK, useCoarse, useMenu } from '../ui/primitives'
import { IArrowUp, IAt, IClip, IFile, IPlus, IPoll, ISmile, IStop, IX } from '../ui/icons'
import { EmojiPicker } from './EmojiPicker'
import { WorkingHeads } from './WorkingHeads'

/** Same cadence as the classic composer: re-ping "typing" at most every 3 s
 *  while keys move, and clear it 2 s after the last keystroke or on send. */
function useTypingSignal(convoId: string, text: string, enabled: boolean): () => void {
  const live = useRef<{ convoId: string; at: number } | null>(null)
  const idle = useRef<number | null>(null)
  const finish = useCallback(() => {
    if (idle.current !== null) window.clearTimeout(idle.current)
    idle.current = null
    if (live.current) {
      void api.emitTyping(live.current.convoId, true).catch(() => {})
      live.current = null
    }
  }, [])
  useEffect(() => {
    if (!enabled || !text.trim()) { finish(); return }
    const now = Date.now()
    if (!live.current || live.current.convoId !== convoId) {
      finish()
      void api.emitTyping(convoId, false).catch(() => {})
      live.current = { convoId, at: now }
    } else if (now - live.current.at > 3000) {
      void api.emitTyping(convoId, false).catch(() => {})
      live.current.at = now
    }
    if (idle.current !== null) window.clearTimeout(idle.current)
    idle.current = window.setTimeout(finish, 2000)
  }, [text, convoId, enabled, finish])
  useEffect(() => finish, [finish])
  return finish
}

type Pick = { kind: 'all' } | { kind: 'p'; p: Participant }

export function Composer({ convoId, threadRootId = null }: {
  convoId: string
  threadRootId?: string | null
}) {
  const nt = useNT()
  const coarse = useCoarse()
  const me = useMe()
  const isThread = threadRootId !== null
  const scope = isThread ? `${convoId}::thread::${threadRootId}` : convoId
  const draft = useApp((s) => s.composerDrafts[scope] ?? EMPTY_DRAFT)
  const update = useApp((s) => s.updateComposerDraft)
  const setDraft = useCallback((fn: (d: ComposerDraft) => ComposerDraft) => update(scope, fn), [scope, update])
  const replyingId = useApp((s) => (isThread ? null : s.replyingTo[convoId] ?? null))
  const replying = useMessages((s) => (replyingId ? (s.byConvo[convoId] ?? []).find((m) => m.id === replyingId) : undefined))
  const replyName = useParticipants((s) => (replying ? authorOf(s.byId, replying.authorId, nt)?.name : undefined))
  const convo = useConversations((s) => s.list.find((c) => c.id === convoId))
  const byId = useParticipants((s) => s.byId)
  const editor = useRef<RichInputHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [hi, setHi] = useState(0)
  const [poll, setPoll] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [emoji, setEmoji] = useState(false)
  const plus = useMenu()
  const finishTyping = useTypingSignal(convoId, draft.text, !isThread)
  const canSend = draft.text.trim().length > 0 || !!draft.attachment
  // An empty box turns send into Stop while an agent works in this room; a
  // typed message still goes out, and the agent reads it at its next tool call.
  const agentStop = useAgentStop(convoId, !canSend && !uploading)
  const stoppable = agentStop.stoppable
  const stopAgents = async () => {
    const ok = await agentStop.stop()
    if (ok !== null) haptic(ok ? 'success' : 'error')
  }

  // The editor remounts per room (keyed by scope) and hydrates from
  // defaultValue. Calling setValue on open would place a caret, and on
  // phones a caret in a contenteditable raises the keyboard uninvited.
  useEffect(() => {
    setMention(null)
    setPoll(false)
    setEmoji(false)
  }, [scope])

  useEffect(() => {
    if (replyingId) requestAnimationFrame(() => editor.current?.focus())
  }, [replyingId])

  const members = useMemo<Participant[]>(() => (convo?.members ?? [])
    .map((id) => byId[id])
    .filter((p): p is Participant => !!p && p.id !== me), [convo, byId, me])

  const picks = useMemo<Pick[]>(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const out: Pick[] = members.length > 1 && 'all'.startsWith(q) ? [{ kind: 'all' }] : []
    for (const p of members) {
      if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) out.push({ kind: 'p', p })
      if (out.length >= 7) break
    }
    return out
  }, [mention, members])

  /** `@query` right before the caret opens the picker; the boundary rules
   *  (start, whitespace, or right after another mention chip) match the
   *  classic composer so chips typed back to back still trigger it. */
  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) { setMention(null); return }
    const prev = at === 0 ? '' : text[at - 1]
    const afterChip = /@[A-Za-z][\w-]*$/.test(text.slice(0, at))
    const query = before.slice(at + 1)
    if ((prev && !/\s/.test(prev) && !afterChip) || /\s/.test(query) || query.length > 30) { setMention(null); return }
    if (!mention || mention.start !== at || mention.query !== query) {
      setMention({ start: at, query })
      setHi(0)
    }
  }

  const insertMention = (pick: Pick) => {
    if (!mention) return
    const before = draft.text.slice(0, mention.start)
    const after = draft.text.slice(mention.start + 1 + mention.query.length)
    const sep = before && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${sep}@${pick.kind === 'all' ? 'all' : pick.p.id} ${after}`.replace(/ {2,}$/, ' ')
    setMention(null)
    editor.current?.setValue(next)
    requestAnimationFrame(() => editor.current?.focus())
  }

  const upload = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const a: ApiAttachment = await api.uploadFile(file)
      setDraft((d) => ({ ...d, attachment: a }))
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
      window.setTimeout(() => setUploadError(null), 4500)
    } finally {
      setUploading(false)
    }
  }

  const send = () => {
    const text = draft.text.trim()
    if (text === '/poll' && !isThread) { openPoll(); return }
    if (!canSend || uploading) return
    haptic('sent')
    finishTyping()
    void sendUserMessage(convoId, text, draft.attachment, isThread ? threadRootId : replyingId)
    setDraft(() => EMPTY_DRAFT)
    editor.current?.setValue('')
    if (!isThread && replyingId) useApp.getState().setReplyingTo(convoId, null)
    editor.current?.focus()
  }

  const openPoll = () => {
    setPoll(true)
    setDraft(() => EMPTY_DRAFT)
    editor.current?.setValue('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(e)) return
    if (mention && picks.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => (i + 1) % picks.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => (i - 1 + picks.length) % picks.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(picks[hi]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return }
    }
    // Phones: Return is a newline and the button sends, like every messenger.
    if (e.key === 'Enter' && !e.shiftKey && (!coarse || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === 'Escape' && replyingId && !draft.text.trim()) {
      e.preventDefault()
      useApp.getState().setReplyingTo(convoId, null)
    }
    if (e.key === '@') {
      requestAnimationFrame(() => {
        const ed = editor.current
        if (ed) detectMention(ed.getValue(), ed.getCaretOffset())
      })
    }
  }

  const placeholder = isThread ? nt('composer.replyThread') : nt('composer.placeholder', { room: convo?.title ?? '' })

  return (
    <div
      className="nx-composer"
      data-drag={dragging || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) void upload(f)
      }}
    >
      <AnimatePresence initial={false}>
        {(replying || draft.attachment || uploading || uploadError) && (
          <motion.div
            className="nx-composer__chips"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={T_QUICK}
          >
            {replying && (
              <span className="nx-composer__chip">
                <span className="nx-composer__chip-label">{nt('composer.replyingTo', { name: replyName ?? '' })}</span>
                <span className="nx-composer__chip-text">{replying.body}</span>
                <IconButton small label={nt('composer.cancelReply')} onClick={() => useApp.getState().setReplyingTo(convoId, null)}><IX /></IconButton>
              </span>
            )}
            {draft.attachment && (
              <span className="nx-composer__chip">
                {draft.attachment.kind === 'img'
                  ? <img src={draft.attachment.url} alt="" className="nx-composer__thumb" />
                  : <IFile />}
                <span className="nx-composer__chip-text">{draft.attachment.name}</span>
                <IconButton small label={nt('composer.removeFile')} onClick={() => setDraft((d) => ({ ...d, attachment: null }))}><IX /></IconButton>
              </span>
            )}
            {uploading && <span className="nx-composer__chip"><Spinner />{nt('composer.uploading')}</span>}
            {uploadError && <span className="nx-composer__chip nx-composer__chip--error" role="alert">{uploadError}</span>}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {emoji && (
          <EmojiPicker
            key="emoji"
            onClose={() => setEmoji(false)}
            onEmoji={(e) => editor.current?.insertText(e)}
            onSkype={(key) => editor.current?.insertSkype(key)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {mention && picks.length > 0 && (
          <motion.div
            className="nx-mentions"
            role="listbox"
            aria-label={nt('composer.mention')}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={T_QUICK}
          >
            {picks.map((pk, i) => (
              <button
                key={pk.kind === 'all' ? '@all' : pk.p.id}
                type="button"
                role="option"
                aria-selected={i === hi}
                className="nx-menu__item"
                data-highlighted={i === hi || undefined}
                onMouseDown={(e) => { e.preventDefault(); insertMention(pk) }}
                onMouseMove={() => setHi(i)}
              >
                {pk.kind === 'all'
                  ? <><span className="nx-room-glyph"><IAt /></span><span>@all</span><span className="nx-mentions__sub">{nt('composer.everyone')}</span></>
                  : <><Avatar p={pk.p} size={24} presence /><span>{pk.p.name}</span>{pk.p.role && <span className="nx-mentions__sub">{pk.p.role}</span>}</>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {!isThread && <WorkingHeads key={convoId} convoId={convoId} />}
      <div className="nx-composer__bar">
        <IconButton label={nt('composer.add')} onClick={(e) => plus.toggleFrom(e.currentTarget)}><IPlus /></IconButton>
        <RichInput
          key={scope}
          ref={editor}
          defaultValue={useApp.getState().composerDrafts[scope]?.text ?? ''}
          className="nx-composer__input"
          placeholder={placeholder}
          ariaLabel={placeholder}
          maxHeight={coarse ? 140 : 200}
          enterKeyHint={coarse ? 'enter' : 'send'}
          onChange={(value, caret) => {
            setDraft((d) => ({ ...d, text: value }))
            detectMention(value, caret)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            for (const it of e.clipboardData?.items ?? []) {
              const f = it.kind === 'file' ? it.getAsFile() : null
              if (f && f.type.startsWith('image/')) { e.preventDefault(); void upload(f); return }
            }
          }}
          resolveMention={(id) => {
            const p = byId[id]
            return p ? { name: p.name, initial: p.initial || p.name.charAt(0), avatarBg: p.avatarBg, kind: p.kind, avatarUrl: p.avatarUrl ?? undefined } : null
          }}
        />
        <IconButton label={nt('composer.emoji')} active={emoji} data-emoji-toggle onClick={() => setEmoji((v) => !v)}><ISmile /></IconButton>
        {!coarse && canSend && <Kbd>↵</Kbd>}
        <button
          type="button"
          className="nx-send"
          data-ready={canSend || undefined}
          data-stop={stoppable || undefined}
          disabled={stoppable ? agentStop.busy : !canSend || uploading}
          aria-busy={agentStop.busy || undefined}
          aria-label={stoppable ? nt('composer.stop', { name: agentStop.names }) : nt('composer.send')}
          aria-keyshortcuts={stoppable ? undefined : 'Enter'}
          onPointerDown={(e) => e.preventDefault() /* keep the keyboard up on phones */}
          onClick={stoppable ? stopAgents : send}
        >
          {stoppable ? (agentStop.busy ? <Spinner /> : <IStop />) : <IArrowUp />}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void upload(f)
        }}
      />
      <Menu
        open={plus.open}
        anchor={plus.anchor}
        onClose={plus.close}
        entries={[
          { key: 'file', label: nt('composer.attach'), icon: <IClip />, onSelect: () => fileInput.current?.click() },
          ...(!isThread ? [{ key: 'poll', label: nt('composer.poll'), icon: <IPoll />, onSelect: openPoll }] : []),
          { key: 'mention', label: nt('composer.mention'), icon: <IAt />, onSelect: () => editor.current?.insertText('@') },
        ]}
      />
      {poll && (
        <div className="nx-composer__poll">
          <PollComposer conversationId={convoId} onSubmitted={() => setPoll(false)} onCancel={() => setPoll(false)} />
        </div>
      )}
    </div>
  )
}
