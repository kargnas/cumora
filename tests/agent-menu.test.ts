/**
 * The agent menu's triggers (src/next/agentRefs.ts), which agents have a
 * screen and threads (src/next/sections/agents/hasWork.ts), and the one-key
 * shortcuts of every Menu (src/next/ui/menuKeys.ts). There is no DOM in the
 * test runner, so a plain object stands in for the app's root element and
 * the events carry the few fields the listeners read.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Computer, Participant } from '../src/types.ts'
import { bindAgentRefs } from '../src/next/agentRefs.ts'
import { hasWork, noWorkReason } from '../src/next/sections/agents/hasWork.ts'
import { shortcutItem } from '../src/next/ui/menuKeys.ts'

type Listener = (e: Event) => void

function setup(menuOpen = false) {
  const listeners = new Map<string, Listener>()
  const root = {
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn) },
    removeEventListener: (type: string) => { listeners.delete(type) },
  }
  const opened: Array<{ id: string; at: { x: number; y: number } | null }> = []
  let held = 0
  const unbind = bindAgentRefs(root as unknown as EventTarget, {
    open: (id, _el, at) => { opened.push({ id, at }) },
    isOpen: () => menuOpen,
    held: () => { held++ },
  })
  const agent = { getAttribute: (name: string) => (name === 'data-agent-id' ? 'atlas' : null), closest: () => agent }
  const inside = { closest: () => agent }
  const elsewhere = { closest: () => null }
  /** Fires `type` at `target` and reports whether a listener took it. */
  const fire = (type: string, target: object, extra: Record<string, unknown> = {}) => {
    let taken = false
    const e = { target, preventDefault: () => { taken = true }, stopPropagation: () => {}, ...extra }
    listeners.get(type)?.(e as unknown as Event)
    return taken
  }
  return { listeners, opened, held: () => held, unbind, agent, inside, elsewhere, fire }
}

describe('agent menu triggers', () => {
  it('a click on anything inside an agent reference opens its menu under it, and takes the click', () => {
    const t = setup()
    assert.equal(t.fire('click', t.inside, { button: 0 }), true)
    assert.deepEqual(t.opened, [{ id: 'atlas', at: null }])
  })

  it('leaves clicks elsewhere and other buttons alone', () => {
    const t = setup()
    assert.equal(t.fire('click', t.elsewhere, { button: 0 }), false)
    assert.equal(t.fire('click', t.agent, { button: 1 }), false)
    assert.deepEqual(t.opened, [])
  })

  it('a right-click opens it at the pointer; the context-menu key, under the element', () => {
    const t = setup()
    t.fire('contextmenu', t.agent, { clientX: 120, clientY: 340 })
    t.fire('contextmenu', t.agent, { clientX: 0, clientY: 0 })
    assert.deepEqual(t.opened, [{ id: 'atlas', at: { x: 120, y: 340 } }, { id: 'atlas', at: null }])
    assert.equal(t.held(), 0)
  })

  it('a long press (a contextmenu right after a touch) plays the hold', () => {
    const t = setup()
    t.listeners.get('touchstart')?.({} as Event)
    t.fire('contextmenu', t.agent, { clientX: 10, clientY: 10 })
    assert.equal(t.held(), 1)
  })

  it('Enter and Space open it only on the focused reference itself', () => {
    const t = setup()
    assert.equal(t.fire('keydown', t.inside, { key: 'Enter' }), false)
    assert.equal(t.fire('keydown', t.agent, { key: 'Enter' }), true)
    assert.equal(t.fire('keydown', t.agent, { key: ' ' }), true)
    assert.equal(t.fire('keydown', t.agent, { key: 'a' }), false)
    assert.equal(t.opened.length, 2)
  })

  it('lets Enter through while the menu is open, so it picks the highlighted row', () => {
    const t = setup(true)
    assert.equal(t.fire('keydown', t.agent, { key: 'Enter' }), false)
    assert.deepEqual(t.opened, [])
  })

  it('unbinds every listener', () => {
    const t = setup()
    t.unbind()
    assert.equal(t.listeners.size, 0)
  })
})

describe('which agents have a screen and threads', () => {
  const agent = { id: 'atlas', kind: 'agent', name: 'Atlas', computerId: 'mbp' } as unknown as Participant
  const host = (kind: string) => ({ id: 'mbp', kind }) as unknown as Computer

  it('an agent on its own computer has them', () => {
    assert.equal(hasWork(agent, host('local')), true)
  })

  it('a Cumora Cloud agent never has them, even with a cloud-<company> computer id', () => {
    assert.equal(hasWork({ ...agent, computerId: 'cloud-acme' }, host('cloud')), false)
    assert.equal(hasWork({ ...agent, computerId: null }, undefined), false)
  })

  it('an empty tile says why, by the same rules', () => {
    assert.equal(noWorkReason(agent, host('local'), true), null)
    assert.equal(noWorkReason(agent, undefined, true), null)
    assert.equal(noWorkReason(agent, host('local'), false), 'locked')
    assert.equal(noWorkReason({ ...agent, computerId: 'cloud-acme' }, host('cloud'), true), 'cloud')
    assert.equal(noWorkReason({ ...agent, computerId: null }, undefined, false), 'cloud')
    assert.equal(noWorkReason({ ...agent, departedAt: '2026-10-01T00:00:00Z' }, host('local'), true), 'departed')
  })

  it('nor an unknown host, an off-boarded agent or a person', () => {
    assert.equal(hasWork(agent, undefined), false)
    assert.equal(hasWork({ ...agent, departedAt: '2026-10-01T00:00:00Z' }, host('local')), false)
    assert.equal(hasWork({ ...agent, kind: 'human' }, host('local')), false)
  })
})

describe('menu one-key shortcuts', () => {
  const items = [{ key: 'screen', shortcut: 'S' }, { key: 'mention', shortcut: '@' }, { key: 'up', shortcut: '⌥↑' }, { key: 'stop' }]
  const key = (k: string, target: object | null = { tagName: 'SPAN' }, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    shortcutItem(items, { key: k, ctrlKey: false, metaKey: false, altKey: false, target: target as EventTarget | null, ...mods })?.key

  it('picks the item whose one-character shortcut matches, without case', () => {
    assert.equal(key('s'), 'screen')
    assert.equal(key('S'), 'screen')
    assert.equal(key('@'), 'mention')
  })

  it('never fires for a key typed into a field, with a modifier, or a hint of several characters', () => {
    assert.equal(key('s', { tagName: 'INPUT' }), undefined)
    assert.equal(key('s', { tagName: 'TEXTAREA' }), undefined)
    assert.equal(key('s', { tagName: 'DIV', isContentEditable: true }), undefined)
    assert.equal(key('s', null, { metaKey: true }), undefined)
    assert.equal(key('ArrowUp'), undefined)
    assert.equal(key('x'), undefined)
  })
})
