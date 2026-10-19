import type { Participant } from '@/types'
import type { NT } from '../i18n'

/** What an agent deleted for good wrote in rooms that stay carries this author
 *  id prefix, and no participant (server/src/fork/purge.ts). */
const DELETED_AUTHOR_PREFIX = 'deleted:'

/** A message's author: its participant, or a stand-in for a deleted agent so
 *  the message keeps an avatar and a name. */
export function authorOf(byId: Record<string, Participant>, id: string, nt: NT): Participant | undefined {
  if (byId[id] || !id.startsWith(DELETED_AUTHOR_PREFIX)) return byId[id]
  return { id, kind: 'agent', name: nt('msg.deletedAgent'), initial: '?', avatarBg: 'var(--muted)', status: 'resting' }
}
