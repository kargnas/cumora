/**
 * Accessories on a bloub. The mistakes worth catching: ears that come loose
 * from the body or fall out of step with the eyes after an engine update (they
 * read the engine's private outline and copy two of its facts), ears left
 * floating while the body shrinks to a dot, whiskers on a face that is not
 * there, and an older app's save taking accessories off.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessoryIds } from '../server/src/fork/router.ts'
import { AccessoryRig, FACE_MORPH, outlineOf, STATE_FACES } from '../src/next/bloub/accessories.ts'
import { BotEngine } from '../src/next/bloub/engine/engine.ts'
import { EXPRESSION_BY_ID } from '../src/next/bloub/engine/expressions.ts'
import { SHAPE_BY_ID, SHAPES } from '../src/next/bloub/engine/skins.ts'
import { STATES } from '../src/next/bloub/engine/states.ts'

function bot(shape: string) {
  const engine = new BotEngine(100, 'idle', SHAPE_BY_ID.get(shape as never)?.radii ?? null, EXPRESSION_BY_ID.get('neutre') ?? null)
  engine.reset('idle', 0)
  return { engine, rig: new AccessoryRig(0, 'neutre') }
}

const translation = (matrix: string) => matrix.slice(7, -1).split(',').slice(4).map(Number) as [number, number]

test('the outline the ears read is the body of the frame just sampled', () => {
  const { engine } = bot('galet')
  for (const [state, at] of [['idle', 1], ['thinking', 3]] as const) {
    engine.setState(state, at - 2)
    const frame = engine.sample(at)
    const outline = outlineOf(engine)
    assert.equal(outline.length, 64)
    // The engine's path starts at the first outline point.
    const [, x, y] = frame.bodyPath.match(/^M(-?[\d.]+) (-?[\d.]+)/) ?? []
    assert.ok(Math.hypot(Number(x) - outline[0]!.x, Number(y) - outline[0]!.y) < 0.01, `${state}: outline and body differ`)
  }
})

test('the ears keep the engine’s face timing and know every state that draws its own face', () => {
  assert.equal(FACE_MORPH, BotEngine.SHAPE_MORPH)
  const ownFace = STATES.filter((s) => !s.baseFace).map((s) => s.id).sort()
  assert.deepEqual(Object.keys(STATE_FACES).sort(), ownFace)
})

test('ears sit on the top of the body, one either side, on every shape', () => {
  for (const { id } of SHAPES) {
    const { engine, rig } = bot(id)
    const frame = engine.sample(1)
    const outline = outlineOf(engine)
    const { ears } = rig.update(frame, outline, 1, { shape: id, accessories: ['ears'] }, false) ?? assert.fail('no frame')
    const middle = outline.reduce((sum, p) => sum + p.y, 0) / outline.length
    const [left, right] = ears.map((ear) => translation(ear ?? assert.fail(`${id}: an ear is missing`)))
    for (const [x, y] of [left!, right!]) {
      const gap = Math.min(...outline.map((p) => Math.hypot(p.x - x, p.y - y)))
      assert.ok(gap < 6, `${id}: an ear is ${gap.toFixed(1)} away from the body`)
      assert.ok(y < middle, `${id}: an ear is below the middle of the body`)
    }
    assert.ok(left![0] < right![0], `${id}: the ears swapped sides`)
  }
})

test('a body that shrinks to a dot takes its accessories in, and only those asked for are drawn', () => {
  const { engine, rig } = bot('galet')
  const at = (t: number, accessories: string[]) => rig.update(engine.sample(t), outlineOf(engine), t, { shape: 'galet', accessories }, false)
  assert.equal(at(1, []), null, 'a look that wears nothing costs nothing')
  const ball = at(1, ['ears', 'whiskers']) ?? assert.fail('no frame')
  assert.ok(ball.ears.every(Boolean))
  assert.equal(ball.whiskers.match(/M/g)?.length, 6)
  assert.ok(ball.whiskerAlpha > 0.9)
  // An id from a newer app is kept in the look but drawn as nothing.
  assert.deepEqual(at(1, ['halo']), { ears: [null, null], whiskers: '', whiskerAlpha: 0 })

  engine.setState('thinking', 1)
  const dot = at(3, ['ears', 'whiskers']) ?? assert.fail('no frame')
  assert.deepEqual(dot.ears, [null, null])
  assert.equal(dot.whiskerAlpha, 0)
  engine.setState('idle', 4)
  assert.ok(at(6, ['ears'])?.ears.every(Boolean), 'the ears come back with the ball')
})

test('a pick without accessories keeps them, and a list is checked like a shape', () => {
  // An app built before accessories sends none; undefined is what keeps them on (store.ts).
  assert.equal(accessoryIds(undefined), undefined)
  assert.deepEqual(accessoryIds([]), [])
  assert.deepEqual(accessoryIds(['ears', 'whiskers', 'ears']), ['ears', 'whiskers'])
  assert.throws(() => accessoryIds('ears'))
  assert.throws(() => accessoryIds(['Ears']))
  assert.throws(() => accessoryIds(Array.from({ length: 9 }, (_, i) => 'abcdefghi'[i])))
})
