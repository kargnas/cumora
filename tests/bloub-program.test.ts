/**
 * What a bloub avatar plays for its agent. The mistakes worth catching: an
 * offline computer still shown as busy, a turn's opening or closing effect
 * replayed on every mount, and work that stops animating once its first
 * cycle ends.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Computer, Participant } from '../src/types'
import { advance, flash, modeOf, POSTED, programFor, type Playhead } from '../src/next/bloub/program.ts'

const agent = (over: Partial<Participant> = {}): Participant =>
  ({ id: 'a1', kind: 'agent', name: 'A', initial: 'A', avatarBg: '#000', status: 'avail', ...over }) as Participant
const host = (over: Partial<Computer>): Computer => ({ id: 'c1', kind: 'local', status: 'online', ...over }) as Computer

test('the mode follows the status, and an offline computer wins over it', () => {
  assert.equal(modeOf(agent({ status: 'thinking' }), host({})), 'thinking')
  assert.equal(modeOf(agent({ status: 'working' }), undefined), 'working')
  assert.equal(modeOf(agent({ status: 'waiting' }), undefined), 'waiting')
  assert.equal(modeOf(agent({ status: 'resting' }), undefined), 'offline')
  assert.equal(modeOf(agent({ status: 'thinking' }), host({ status: 'offline' })), 'offline')
  // Cumora Cloud has no computer of the user's to go offline.
  assert.equal(modeOf(agent({ status: 'thinking' }), host({ kind: 'cloud', status: 'offline' })), 'thinking')
  assert.equal(modeOf(agent({ departedAt: '2026-10-18T00:00:00Z' }), undefined), 'offline')
})

test('a turn opens with burst and closes with comet, only on a live change', () => {
  const states = (from: Parameters<typeof programFor>[0], to: Parameters<typeof programFor>[1]) =>
    programFor(from, to).steps.map(([state]) => state)
  assert.deepEqual(states('idle', 'thinking'), ['burst', 'thinking'])
  assert.deepEqual(states('offline', 'working'), ['burst', 'play', 'orbit'])
  assert.deepEqual(states('working', 'idle'), ['comet', 'idle'])
  assert.deepEqual(states('thinking', 'working'), ['play', 'orbit'])
  assert.deepEqual(states('working', 'offline'), ['sleep'])
  assert.deepEqual(states('offline', 'idle'), ['idle'])
  // A freshly mounted avatar shows the state it finds, with no effect.
  assert.deepEqual(states(null, 'thinking'), ['thinking'])
})

test('work keeps alternating after its intro, and a held state stays', () => {
  const entered: Array<[string, number]> = []
  const head: Playhead = { program: programFor('idle', 'working'), index: 0, since: 100 }
  advance(head, 100 + 1.5 + 2 + 3.4 + 2 + 0.1, (state, at) => entered.push([state, Number(at.toFixed(2))]))
  assert.deepEqual(entered, [['play', 101.5], ['orbit', 103.5], ['play', 106.9], ['orbit', 108.9]])

  const held: Playhead = { program: programFor('idle', 'thinking'), index: 0, since: 0 }
  const after: string[] = []
  advance(held, 3600, (state) => after.push(state))
  assert.deepEqual(after, ['thinking'])
  assert.equal(held.index, 1)
})

test('a posted message winks, then the mode plays on without its intro', () => {
  const head: Playhead = { program: flash(POSTED, 'working'), index: 0, since: 0 }
  const entered: string[] = []
  advance(head, 1.6 + 2 + 0.1, (state) => entered.push(state))
  assert.deepEqual(entered, ['play', 'orbit'])
})
