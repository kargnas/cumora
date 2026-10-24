/**
 * What the Computer tab may send into an agent's browser
 * (server/src/fork/screen.ts). Every event is rebuilt from known fields, so
 * nothing a client adds reaches agent-browser, and a key event never carries a
 * null string, which agent-browser answers by dropping the keystroke. And the
 * one wait that a read with `wait=0` (the Agents wall's) still makes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScreenInput, Screen } from '../fork/screen.js'

test('a read that must not wait waits once, until a new stream knows whether a browser is open', async () => {
  // The dashboard has no session for this agent: no browser is open.
  const screen = new Screen('nobody', async () => [])
  try {
    const signal = new AbortController().signal
    const first = await screen.poll(0, signal, false)
    assert.equal(first.state, 'closed')
    assert.equal(first.seq, 1, 'answered before the first look, it would say closed for nothing')
    // Known now, so it answers at once instead of holding (5 s).
    const started = Date.now()
    assert.equal((await screen.poll(first.seq, signal, false)).seq, 1)
    assert.ok(Date.now() - started < 1_000)
  } finally {
    screen.end()
  }
})

test('mouse events keep their fields, clamped, and lose anything else', () => {
  assert.deepEqual(parseScreenInput({ events: [
    { type: 'input_mouse', eventType: 'mousePressed', x: 10.5, y: 20, button: 'left', clickCount: 2, evil: 'x' },
    { type: 'input_mouse', eventType: 'mouseWheel', x: -5, y: 99_999, deltaY: 120, button: 'side' },
  ] }), [
    { type: 'input_mouse', eventType: 'mousePressed', x: 10.5, y: 20, button: 'left', clickCount: 2, deltaX: 0, deltaY: 0, modifiers: 0 },
    { type: 'input_mouse', eventType: 'mouseWheel', x: 0, y: 10_000, button: 'none', clickCount: 0, deltaX: 0, deltaY: 120, modifiers: 0 },
  ])
})

test('key events leave out the strings they lack', () => {
  assert.deepEqual(parseScreenInput({ events: [
    { type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
    { type: 'input_keyboard', eventType: 'char', text: '한' },
  ] }), [
    { type: 'input_keyboard', eventType: 'keyDown', windowsVirtualKeyCode: 13, modifiers: 0, key: 'Enter', code: 'Enter', text: '\r' },
    { type: 'input_keyboard', eventType: 'char', windowsVirtualKeyCode: 0, modifiers: 0, text: '한' },
  ])
})

test('one bad event refuses the whole batch', () => {
  const click = { type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 1 }
  assert.equal(parseScreenInput({ events: [click, { type: 'input_touch', eventType: 'touchStart' }] }), null)
  assert.equal(parseScreenInput({ events: [click, { type: 'input_keyboard', eventType: 'keyDown', key: null }] }), null)
  assert.equal(parseScreenInput({ events: [{ ...click, x: 'left' }] }), null)
  assert.equal(parseScreenInput({ events: [{ type: 'navigate', url: 'https://example.com' }] }), null)
  assert.equal(parseScreenInput({ events: [] }), null)
  assert.equal(parseScreenInput({ events: Array(201).fill(click) }), null)
  assert.equal(parseScreenInput(null), null)
})
