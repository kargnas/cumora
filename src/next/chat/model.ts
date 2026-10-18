import { isCalendarNotice } from '@/lib/conversationRow'
import type { Message } from '@/types'

/** Messages a bubble can show. Tool/thought rows are work, not conversation. */
const WORK_KINDS = new Set<Message['kind']>(['tool', 'thought'])
const LINE_KINDS = new Set<Message['kind']>(['system', 'whisper-link'])
/** Consecutive messages closer than this join one bubble group. */
const GROUP_GAP_MS = 5 * 60_000

export type Pos = 'single' | 'first' | 'middle' | 'last'

export type Item =
  | { type: 'msg'; key: string; msg: Message; mine: boolean; pos: Pos; day: Date | null; at: Date }
  | { type: 'work'; key: string; authorId: string; msgs: Message[]; day: Date | null; at: Date }
  | { type: 'line'; key: string; msg: Message; day: Date | null; at: Date }

export function createdAt(m: Message): Date {
  const iso = (m as Message & { createdAt?: string }).createdAt
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d : new Date()
}

export function keyOf(m: Message): string {
  return m.clientId ?? m.id
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Flatten a transcript into render items: tool/thought runs collapse into a
 * single work item per author, the first item of each calendar day carries
 * the day separator, and bubbles from one author in quick succession get
 * first/middle/last positions so corners and avatars group like a messenger.
 * Calendar firings are left out: the room panel's Routines tab tracks runs.
 */
export function buildItems(messages: Message[], meId: string | null): Item[] {
  const out: Item[] = []
  let prevDay: Date | null = null
  for (const m of messages) {
    if (isCalendarNotice(m)) continue
    const at = createdAt(m)
    const day = prevDay && sameDay(prevDay, at) ? null : at
    prevDay = at
    const last = out[out.length - 1]

    if (WORK_KINDS.has(m.kind)) {
      if (last?.type === 'work' && last.authorId === m.authorId && !day) {
        last.msgs.push(m)
        last.at = at
      } else {
        out.push({ type: 'work', key: `w-${keyOf(m)}`, authorId: m.authorId, msgs: [m], day, at })
      }
      continue
    }
    if (LINE_KINDS.has(m.kind)) {
      out.push({ type: 'line', key: keyOf(m), msg: m, day, at })
      continue
    }

    const joins = last?.type === 'msg'
      && last.msg.authorId === m.authorId
      && !day
      && m.kind !== 'poll' && last.msg.kind !== 'poll'
      && at.getTime() - last.at.getTime() < GROUP_GAP_MS
    if (joins && last.type === 'msg') last.pos = last.pos === 'single' ? 'first' : 'middle'
    out.push({ type: 'msg', key: keyOf(m), msg: m, mine: m.authorId === meId, pos: joins ? 'last' : 'single', day, at })
  }
  return out
}
