/**
 * What the top of the Handbook shows before the full text: a map of the whole
 * document, one short bar per line, with changed lines in their change colour,
 * and an excerpt of every change. Both are read off the rows the full text
 * renders, so a press on either lands on a row of that list. Kept apart from
 * HandbookTab.tsx so they can be tested without a DOM.
 */
import type { ChangedLine, HandbookFile, SectionKey } from './handbook'

/** The parts of HandbookTab's rows these read. */
export type MapRow =
  | { kind: 'section'; section: SectionKey }
  | { kind: 'file'; file: HandbookFile; fold?: 'open' | 'closed' }
  | { kind: 'same'; lines: string[] }
  | { kind: 'change'; n: number; lines: ChangedLine[] }
  | { kind: 'end' }

/** No mark: a blank line. */
export type Mark = 'same' | 'fold' | ChangedLine['op']
export interface Bar { width: number; mark: Mark | null; row: number }
export interface MapColumn { section: SectionKey; row: number; bars: Bar[]; changes: number[] }

/** A column longer than this many lines merges neighbours into one bar, so a
 *  4,000-line memory file stays as short as a 40-line one. */
export const MAP_BARS = 40
const CHANGED: Mark[] = ['edit', 'ins', 'del']

// 80 characters fill the column; a wrapped line just reads as full.
const widthOf = (chars: number) => (chars === 0 ? 0 : Math.min(100, Math.max(8, Math.round(chars * 1.25))))
const charsOf = (line: ChangedLine) => (line.op === 'edit' ? line.segs.reduce((n, [, s]) => n + s.length, 0) : line.text.length)

/** One bar per line merged into at most `max` per section. A merged bar takes
 *  the colour and the row of a changed line inside it, so a change never
 *  disappears into its neighbours. */
export function mapOf(rows: MapRow[], max = MAP_BARS): MapColumn[] {
  const columns: MapColumn[] = []
  let col: MapColumn | undefined
  rows.forEach((r, row) => {
    if (r.kind === 'section') columns.push((col = { section: r.section, row, bars: [], changes: [] }))
    if (!col || r.kind === 'section' || r.kind === 'end') return
    if (r.kind === 'file') {
      // A folded skill is one bar, like its one row; any other file starts
      // with a blank bar that sets it apart from the file above.
      if (r.fold === 'closed') col.bars.push({ width: 40, mark: 'fold', row })
      else if (col.bars.length > 0) col.bars.push({ width: 0, mark: null, row })
    } else if (r.kind === 'same') {
      for (const t of r.lines) col.bars.push({ width: widthOf(t.length), mark: t ? 'same' : null, row })
    } else {
      if (!col.changes.includes(r.n)) col.changes.push(r.n)
      for (const l of r.lines) col.bars.push({ width: widthOf(charsOf(l)), mark: l.op, row })
    }
  })
  for (const c of columns) {
    if (c.bars.length <= max) continue
    const size = Math.ceil(c.bars.length / max)
    const merged: Bar[] = []
    for (let i = 0; i < c.bars.length; i += size) {
      const group = c.bars.slice(i, i + size)
      const changed = group.find((b) => b.mark && CHANGED.includes(b.mark))
      const mark = changed?.mark ?? (group.some((b) => b.mark === 'same') ? 'same' : group.find((b) => b.mark)?.mark ?? null)
      merged.push({ width: Math.max(...group.map((b) => b.width)), mark, row: (changed ?? group[0]).row })
    }
    c.bars = merged
  }
  return columns
}

/** One change: the rows of its hunks (all in one file, since a change is one
 *  version of one file) and the line of the new text where it starts. */
export interface Excerpt { n: number; file: HandbookFile; line: number; rows: number[] }

/** Every change the rows show, newest first. */
export function excerptsOf(rows: MapRow[]): Excerpt[] {
  const byN = new Map<number, Excerpt>()
  let file: HandbookFile | undefined
  let line = 0
  rows.forEach((r, row) => {
    if (r.kind === 'file') {
      file = r.file
      line = 0
    } else if (r.kind === 'same') {
      line += r.lines.length
    } else if (r.kind === 'change' && file) {
      const ex = byN.get(r.n)
      if (ex) ex.rows.push(row)
      else byN.set(r.n, { n: r.n, file, line: line + 1, rows: [row] })
      line += r.lines.filter((l) => l.op !== 'del').length
    }
  })
  return [...byN.values()].sort((a, b) => b.n - a.n)
}
