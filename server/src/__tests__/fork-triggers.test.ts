/**
 * The pure parts of the fork's triggers: reading a gh profile's token and
 * choosing which merged pull requests a trigger fires for. A mistake in either
 * fires nothing (a token read as null) or fires history (merges from before
 * the trigger), so both are pinned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueFor, tokenOf, type MergedPr } from '../fork/triggers.js'

const HOSTS = `github.com:
    users:
        kargnas:
            oauth_token: gho_user
    git_protocol: https
    user: kargnas
    oauth_token: gho_active
`

test('the token is the host-level one, then any, then none', () => {
  assert.equal(tokenOf(HOSTS), 'gho_active')
  assert.equal(tokenOf('github.com:\n    users:\n        kargnas:\n            oauth_token: gho_only\n'), 'gho_only')
  assert.equal(tokenOf('ghe.example.com:\n    oauth_token: gho_other\n'), null)
  assert.equal(tokenOf(''), null)
})

const pr = (number: number, mergedAt: string): MergedPr =>
  ({ number, title: `pr ${number}`, url: '', author: 'a', base: 'main', mergedAt })

test('a trigger fires for merges after it was made, oldest first', () => {
  const pulls = [pr(3, '2026-10-19T03:00:00Z'), pr(1, '2026-10-19T01:00:00Z'), pr(2, '2026-10-19T02:00:00Z')]
  assert.deepEqual(dueFor({ since: '2026-10-19T01:30:00.500Z' }, pulls).map((p) => p.number), [2, 3])
  assert.deepEqual(dueFor({ since: '2026-10-19T03:00:00Z' }, pulls), [], 'a merge at the trigger time is history')
})
