/**
 * Question cards in the redesign's transcript (src/next/chat/cardAnswers.ts).
 * The mistakes worth catching: a reply known only by its client id drawn as a
 * bubble for a frame, the transcript rebuilding its rows for a card that
 * changed nothing there, a quote of the question or of its reply missing the
 * question, and the waiting pill showing for a secret request or for a
 * question a person already answered by quoting it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Card, CardAnswer } from '../src/next/chat/cards.ts'
import { answerKind, questionOf, roomAnswers, waitingQuestion } from '../src/next/chat/cardAnswers.ts'

/** The minute in `createdAt` is the id's last digit, so a higher digit is newer. */
const card = (messageId: string, over: Partial<Card> = {}): Card => ({
  messageId, conversationId: 'room', agentId: 'bot', kind: 'choice', question: `${messageId}?`, options: ['A', 'B'],
  createdAt: `2026-10-23T13:0${messageId.slice(-1)}:00.000Z`, answer: null, takenAt: null, expiresAt: null, rev: 0, ...over,
})
const answer = (clientId: string, messageId: string | null = null): CardAnswer =>
  ({ by: 'u1', at: '2026-10-23T13:10:00.000Z', option: 0, text: null, clientId, messageId })

test('a reply is known by its client id before it is posted, and the index stays while nothing changes', () => {
  const claimed = card('m-q1', { answer: answer('card-1') })
  const first = roomAnswers([claimed, card('m-q2')], 'room')
  assert.equal(answerKind(first, { id: 'local-1', clientId: 'card-1' }), 'choice')
  const settled = { ...claimed, answer: answer('card-1', 'm-a1'), rev: 2 }
  const second = roomAnswers([settled], 'room', first)
  assert.notEqual(second, first, 'the posted id joins the index')
  assert.equal(answerKind(second, { id: 'm-a1' }), 'choice')
  assert.equal(roomAnswers([{ ...settled, rev: 3 }], 'room', second), second, 'a change that keeps the replies keeps the index')
  assert.equal(answerKind(second, { id: 'm-other' }), undefined)
})

test('a quote of the question or of its reply finds the question, never a secret request', () => {
  const question = card('m-q1', { answer: answer('card-1', 'm-a1') })
  const secret = card('m-s2', { kind: 'secret', options: [], answer: answer('card-2', 'm-a2') })
  const byMessage = { [question.messageId]: question, [secret.messageId]: secret }
  const answers = roomAnswers([question, secret], 'room')
  assert.equal(questionOf(byMessage, answers, 'm-q1'), question)
  assert.equal(questionOf(byMessage, answers, 'm-a1'), question)
  assert.equal(questionOf(byMessage, answers, 'm-s2'), undefined)
  assert.equal(questionOf(byMessage, answers, 'm-a2'), undefined)
})

test('the room waits on its newest open question, not on a secret or a question answered by a quoting reply', () => {
  const older = card('m-q1')
  const newer = card('m-q2')
  const others = [card('m-s3', { kind: 'secret', options: [] }), card('m-q4', { conversationId: 'elsewhere' })]
  assert.equal(waitingQuestion([older, newer, ...others], 'room', new Set()), newer)
  assert.equal(waitingQuestion([older, newer], 'room', new Set(['m-q2'])), older, 'a person quoted the newer one')
  assert.equal(waitingQuestion([older, card('m-q2', { answer: answer('card-1') })], 'room', new Set(['m-q1'])), undefined)
})
