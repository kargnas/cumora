/**
 * Line and word diffs for the Handbook (./handbook.ts). The server image has
 * no diff library, and these two shapes are all the Handbook needs.
 */

// The DP table of the part between the common prefix and suffix. 1M cells is
// 2 MB of Uint16 (an LCS is never longer than its shorter side, at most 1000
// here), enough for a full rewrite of a 1000-line file.
// ponytail: past that the middle shows as removed and added whole; switch to
// Myers' O(ND) diff if handbook files that large get edited in place.
const MAX_CELLS = 1_000_000

/** Index pairs [i, j] with a[i] === b[j], increasing in both: a longest common
 *  subsequence of a and b, the lines (or words) that a change kept. */
export function commonPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }

  const pairs: Array<[number, number]> = []
  for (let i = 0; i < start; i++) pairs.push([i, i])
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    // t[i * w + j]: length of the LCS of a[start + i ..] and b[start + j ..], within the middle.
    const w = m + 1
    const t = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[start + i] === b[start + j]
          ? t[(i + 1) * w + j + 1] + 1
          : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { pairs.push([start + i, start + j]); i++; j++ }
      // On a tie the removal goes first, so a replaced line reads removed, then added.
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
      else j++
    }
  }
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k])
  return pairs
}

export type Seg = ['=' | '-' | '+', string]

// Runs of letters or digits are words; Han characters stand alone because
// Chinese puts no space between words; whitespace runs and every other
// character are tokens of their own, so the tokens join back to the line.
const TOKEN = /\s+|\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+|[^\s\p{L}\p{N}_]/gu

/** The words that changed from line `a` to line `b`, or null when the two
 *  share too little for an inline diff to read better than a removed line
 *  followed by an added one. */
export function diffWords(a: string, b: string): Seg[] | null {
  const ta = a.match(TOKEN) ?? []
  const tb = b.match(TOKEN) ?? []
  const segs: Seg[] = []
  const push = (op: Seg[0], text: string) => {
    const last = segs[segs.length - 1]
    if (last?.[0] === op) last[1] += text
    else segs.push([op, text])
  }
  let i = 0
  let j = 0
  let kept = 0
  for (const [pi, pj] of [...commonPairs(ta, tb), [ta.length, tb.length]]) {
    while (i < pi) push('-', ta[i++])
    while (j < pj) push('+', tb[j++])
    if (pi === ta.length) break
    push('=', ta[pi])
    kept += ta[pi].trim().length
    i++
    j++
  }
  // Half the longer line's visible characters must survive, or the inline
  // marks would cover most of the line anyway.
  const longer = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length)
  return longer > 0 && kept * 2 >= longer ? segs : null
}
