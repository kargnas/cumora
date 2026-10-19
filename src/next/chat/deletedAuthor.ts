import type { Participant } from '@/types'
import type { NT } from '../i18n'

/** What an agent deleted for good wrote in rooms that stay carries this author
 *  id prefix, and no participant (server/src/fork/purge.ts). */
const DELETED_AUTHOR_PREFIX = 'deleted:'

/** One stand-in per id and language, so a memoized bubble keeps its props. */
const standIns = new Map<string, Participant>()

/** A message's author: its participant, or a stand-in for a deleted agent so
 *  the message keeps an avatar and a name. */
export function authorOf(byId: Record<string, Participant>, id: string, nt: NT): Participant | undefined {
  if (byId[id] || !id.startsWith(DELETED_AUTHOR_PREFIX)) return byId[id]
  const name = nt('msg.deletedAgent')
  const key = `${id}\n${name}`
  let standIn = standIns.get(key)
  if (!standIn) {
    standIn = { id, kind: 'agent', name, initial: '?', avatarBg: 'var(--muted)', status: 'resting' }
    standIns.set(key, standIn)
  }
  return standIn
}
