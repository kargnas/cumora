/**
 * The Handbook's diffs: the kept lines must be a longest common subsequence
 * (a shorter one marks unchanged lines as changed), and a word diff must
 * rebuild both lines exactly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commonPairs, diffWords, type Seg } from '../fork/diff.js'

function lcsLength(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
    }
  }
  return t[0][0]
}

test('commonPairs keeps a longest common subsequence', () => {
  const cases: Array<[string, string]> = [
    ['abc', 'abc'],
    ['abc', 'axc'],
    ['abc', ''],
    ['', 'abc'],
    ['abcdef', 'abXdeYf'],
    // Repeated lines (blank lines, list markers) are where a greedy match goes wrong.
    ['a--b--c', '-a-b-c-'],
    ['xaxbxcx', 'abc'],
    ['# T\n\n- a\n- b\n\n## U\n- c', '# T\n\n- a\n- B\n- b\n\n## U\n\n- c'],
  ]
  for (const [x, y] of cases) {
    const a = x.includes('\n') ? x.split('\n') : [...x]
    const b = y.includes('\n') ? y.split('\n') : [...y]
    const pairs = commonPairs(a, b)
    pairs.forEach(([i, j], k) => {
      assert.equal(a[i], b[j], `${x} / ${y}: pair ${k} joins different lines`)
      if (k > 0) assert.ok(i > pairs[k - 1][0] && j > pairs[k - 1][1], `${x} / ${y}: pairs go back`)
    })
    assert.equal(pairs.length, lcsLength(a, b), `${x} / ${y}: not a longest common subsequence`)
  }
})

test('a middle too large to compare keeps its common prefix and suffix', () => {
  const a = ['head', ...Array.from({ length: 1001 }, (_, i) => `old ${i}`), 'tail']
  const b = ['head', ...Array.from({ length: 1001 }, (_, i) => `new ${i}`), 'tail']
  assert.deepEqual(commonPairs(a, b), [[0, 0], [1002, 1002]])
})

const side = (segs: Seg[], keep: '-' | '+') => segs.filter(([op]) => op === '=' || op === keep).map(([, s]) => s).join('')

test('diffWords marks the words that changed and rebuilds both lines', () => {
  const cases: Array<[string, string, Seg[]]> = [
    ['Post the digest at 9am', 'Post the digest at 10am', [['=', 'Post the digest at '], ['-', '9am'], ['+', '10am']]],
    ['- Ask before you merge.', '- Ask Sangrak before you merge a PR.', [['=', '- Ask '], ['+', 'Sangrak '], ['=', 'before you merge'], ['+', ' a PR'], ['=', '.']]],
    ['每天早上发送摘要', '每天晚上发送摘要', [['=', '每天'], ['-', '早'], ['+', '晚'], ['=', '上发送摘要']]],
  ]
  for (const [a, b, want] of cases) {
    const segs = diffWords(a, b)
    assert.deepEqual(segs, want)
    assert.equal(side(want, '-'), a)
    assert.equal(side(want, '+'), b)
  }
})

test('diffWords leaves lines that share too little unpaired', () => {
  assert.equal(diffWords('Weekly digest goes to #eng', 'Never touch the shared secrets'), null)
  assert.equal(diffWords('', 'New line'), null)
})
