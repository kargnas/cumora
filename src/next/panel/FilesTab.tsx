import { useMemo, useState } from 'react'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import {
  artifactKey, artifactRefsForMessage, type ArtifactRef,
  DocumentArtifactCard, BoardArtifactCard, CardArtifactCard, CalendarArtifactCard,
} from '@/components/Message'
import { ImageViewer } from '@/components/ImageViewer'
import type { Conversation, Message } from '@/types'
import { useNT } from '../i18n'
import { authorOf } from '../chat/deletedAuthor'
import { bytes } from '../format'
import { IDownload, IFile } from '../ui/icons'

const EMPTY: Message[] = []

/** Files and artifacts from the part of the transcript that is loaded. */
export function FilesTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const messages = useMessages((s) => s.byConvo[c.id] ?? EMPTY)
  const hasMore = useMessages((s) => s.hasMoreOlder[c.id] ?? false)
  const byId = useParticipants((s) => s.byId)
  const [viewer, setViewer] = useState<{ src: string; name: string } | null>(null)
  const { images, files, artifacts } = useMemo(() => {
    const images: Message[] = []
    const files: Message[] = []
    const seen = new Map<string, ArtifactRef & { convo: string }>()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.attachment?.url) (m.attachment.kind === 'img' ? images : files).push(m)
      for (const ref of artifactRefsForMessage(m)) {
        if (!seen.has(artifactKey(ref))) seen.set(artifactKey(ref), { ...ref, convo: m.conversationId })
      }
    }
    return { images, files, artifacts: [...seen.values()] }
  }, [messages])

  if (images.length + files.length + artifacts.length === 0) {
    return <div className="nx-empty">{nt('files.none')}</div>
  }
  return (
    <div className="nx-files">
      {images.length > 0 && (
        <>
          <h3 className="nx-group-label">{nt('files.images')}</h3>
          <div className="nx-files__grid">
            {images.map((m) => (
              <button key={m.id} type="button" className="nx-files__img" onClick={() => setViewer({ src: m.attachment!.url!, name: m.attachment!.name })} aria-label={m.attachment!.name}>
                <img src={m.attachment!.url} alt="" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        </>
      )}
      {files.length > 0 && (
        <>
          <h3 className="nx-group-label">{nt('files.files')}</h3>
          {files.map((m) => (
            <a key={m.id} className="nx-att-file nx-att-file--row" href={m.attachment!.url} download={m.attachment!.name} target="_blank" rel="noopener noreferrer">
              <span className="nx-att-file__icon"><IFile /></span>
              <span className="nx-att-file__text">
                <span className="nx-att-file__name">{m.attachment!.name}</span>
                <span className="nx-att-file__meta nx-mono">{[authorOf(byId, m.authorId, nt)?.name, m.attachment!.size ? bytes(m.attachment!.size) : null].filter(Boolean).join(' · ')}</span>
              </span>
              <IDownload className="nx-att-file__dl" />
            </a>
          ))}
        </>
      )}
      {artifacts.length > 0 && (
        <>
          <h3 className="nx-group-label">{nt('files.artifacts')}</h3>
          <div className="nx-artifacts">
            {artifacts.map((ref) => ref.type === 'document'
              ? <DocumentArtifactCard key={artifactKey(ref)} id={ref.id} conversationId={ref.convo} />
              : ref.type === 'board'
                ? <BoardArtifactCard key={artifactKey(ref)} id={ref.id} />
                : ref.type === 'card'
                  ? <CardArtifactCard key={artifactKey(ref)} id={ref.id} />
                  : <CalendarArtifactCard key={artifactKey(ref)} id={ref.id} />)}
          </div>
        </>
      )}
      {hasMore && <p className="nx-files__note">{nt('files.partial')}</p>}
      {viewer && <ImageViewer src={viewer.src} name={viewer.name} onClose={() => setViewer(null)} />}
    </div>
  )
}
