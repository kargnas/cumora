/**
 * Thread view in the right panel. Replies are fetched once, then merged with
 * replies that arrive live through the conversation store (any message whose
 * quotedMessageId is the root), the same contract as the classic drawer.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type ApiMessage } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Message } from '@/types'
import { useNT } from '../i18n'
import { Bubble } from '../chat/MessageList'
import { Composer } from '../chat/Composer'
import { createdAt } from '../chat/model'
import { authorOf } from '../chat/deletedAuthor'
import { answersCard, useHiddenAnswers } from '../chat/cards'
import { Spinner } from '../ui/primitives'

const EMPTY: Message[] = []

function fromApi(m: ApiMessage): Message {
  const raw = m as unknown as Partial<Message> & { createdAt?: string }
  const out: Message = {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    kind: m.kind as Message['kind'],
    body: m.body,
    at: '',
    reactions: m.reactions && m.reactions.length > 0 ? m.reactions : undefined,
    attachment: raw.attachment ?? undefined,
    quotedMessageId: raw.quotedMessageId ?? undefined,
    quoted: raw.quoted ?? undefined,
    replyCount: raw.replyCount ?? undefined,
    clientId: raw.clientId ?? undefined,
  }
  ;(out as Message & { createdAt?: string }).createdAt = raw.createdAt
  return out
}

export function ThreadView({ convoId, rootId }: { convoId: string; rootId: string }) {
  const nt = useNT()
  const me = useMe()
  const root = useMessages((s) => (s.byConvo[convoId] ?? EMPTY).find((m) => m.id === rootId))
  const live = useMessages((s) => s.byConvo[convoId] ?? EMPTY)
  const byId = useParticipants((s) => s.byId)
  const direct = useConversations((s) => s.list.find((x) => x.id === convoId)?.kind === 'direct')
  const [fetched, setFetched] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const answers = useHiddenAnswers(convoId)

  useEffect(() => {
    let cancelled = false
    setFetched(null)
    setError(null)
    api.getReplies(convoId, rootId)
      .then((rows) => { if (!cancelled) setFetched(rows.map(fromApi)) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [convoId, rootId])

  // Live rows win over fetched ones (they carry reactions and the optimistic
  // pending/failed flags); matching by id or by the optimistic client id. A
  // reply that answered the root's card shows in the card, not here.
  const replies = useMemo(() => {
    const out = [...(fetched ?? [])]
    for (const m of live) {
      if (m.quotedMessageId !== rootId) continue
      const i = out.findIndex((x) => x.id === m.id || (!!x.clientId && x.clientId === m.clientId))
      if (i >= 0) out[i] = m
      else out.push(m)
    }
    return out
      .filter((m) => !answersCard(answers, m))
      .sort((a, b) => createdAt(a).getTime() - createdAt(b).getTime())
  }, [fetched, live, rootId, answers])

  return (
    <div className="nx-thread">
      <div className="nx-thread__list nx-scroll" data-direct={direct || undefined}>
        {root && (
          <div className="nx-thread__root">
            <Bubble msg={{ ...root, replyCount: 0 }} author={authorOf(byId, root.authorId, nt)} mine={root.authorId === me} pos="single" stamp="turn" fresh={false} at={createdAt(root)} />
          </div>
        )}
        <div className="nx-group-label">{nt(replies.length === 1 ? 'msg.oneReply' : 'msg.replies', { n: replies.length })}</div>
        {fetched === null && !error && <div className="nx-center" aria-busy="true"><Spinner /></div>}
        {error && <div className="nx-empty" role="alert">{nt('msg.loadFailed')}</div>}
        {replies.map((m) => (
          // Quotes are implied by the thread itself, so the card is dropped.
          <Bubble key={m.clientId ?? m.id} msg={{ ...m, quoted: undefined }} author={authorOf(byId, m.authorId, nt)} mine={m.authorId === me} pos="single" stamp="turn" fresh={false} at={createdAt(m)} />
        ))}
      </div>
      <div className="nx-thread__composer">
        <Composer convoId={convoId} threadRootId={rootId} />
      </div>
    </div>
  )
}
