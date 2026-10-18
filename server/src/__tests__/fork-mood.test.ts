/**
 * Bloub moods (server/src/fork/mood.ts) send Jev English face names and store
 * the client engine's expression ids. A typo in that mapping would store a face
 * the client draws as its default, and an answer outside the offered faces
 * would store garbage, so both are checked here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPRESSIONS } from '../../../src/next/bloub/engine/expressions'
import { faceOf, moodRequest } from '../fork/mood.js'

test('every face Jev can pick is an expression the client engine draws', () => {
  const ids = new Set(EXPRESSIONS.map((e) => e.id))
  const names = Object.keys(moodRequest('hi').questions.face.criteria)
  assert.equal(names.length, ids.size, 'one face per expression')
  for (const name of names) {
    const id = faceOf({ answers: { face: { choice: name } } })
    assert.ok(id && ids.has(id as never), `${name} maps to ${id}`)
  }
})

test('an answer outside the offered faces stores nothing', () => {
  assert.equal(faceOf({ answers: { face: { choice: 'heureux' } } }), null, 'engine ids are not option names')
  assert.equal(faceOf({ answers: { face: { choice: 'toString' } } }), null)
  assert.equal(faceOf({ answers: {} }), null)
  assert.equal(faceOf(null), null)
})
