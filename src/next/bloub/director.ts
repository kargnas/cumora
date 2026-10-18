/**
 * Runs the bloub avatars on screen. Every avatar of one agent (its chat-list
 * row, its messages, the panel) shares that agent's engine, and one
 * requestAnimationFrame loop drives them all: each frame samples an engine
 * once and draws it into the visible views of that agent. The loop stops when
 * no view is visible and starts again when one is.
 *
 * Signals come from the stores and the socket, not from React: the agent's
 * status and its computer (program.ts modeOf), and the messages it posts.
 */
import { ws } from '@/api/client'
import { useComputers } from '@/stores/computers'
import { useParticipants } from '@/stores/participants'
import type { Message } from '@/types'
import type { BotEngine, BotFrame } from './engine/engine'
import { EXPRESSION_BY_ID } from './engine/expressions'
import { RAYON } from './engine/repere'
import { SHAPE_BY_ID } from './engine/skins'
import type { BloubLook } from './looks'
import { advance, flash, modeOf, POSTED, programFor, type Mode, type Playhead } from './program'
import { createView } from './view'

/** A status that flips for a moment (a 0.2 s tool call) would flash a whole
 *  state in and out, so a mode is applied at most this often; the latest wins. */
const MIN_HOLD = 1.2
/** The messages that count as the agent speaking (as in chat/ChatView.tsx). */
const SPOKEN = new Set<Message['kind']>(['text', 'attachment', 'email', 'poll'])

type Engines = typeof import('./engine/engine')
let engines: Promise<Engines> | null = null
/** The engine module tabulates its eye offsets when it loads (about 25 ms on a
 *  laptop, several times that on a phone), so it loads on first use, not with the app. */
export function loadEngine(): Promise<Engines> {
  return (engines ??= import('./engine/engine'))
}

interface View { draw: (frame: BotFrame) => void; visible: boolean }

interface Bot {
  engine: BotEngine | null
  /** Seconds added to the shared clock, so agents blink and glance at their own moments. */
  offset: number
  look: BloubLook
  mode: Mode
  head: Playhead
  wanted: Mode
  appliedAt: number
  timer: number
  views: Set<View>
  visible: number
}

const bots = new Map<string, Bot>()
let raf = 0
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const still = () => reducedMotion?.matches === true

const clock = () => performance.now() / 1000
const timeOf = (bot: Bot) => clock() + bot.offset

function offsetOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (h >>> 0) % 600
}

const shapeOf = (look: BloubLook) => SHAPE_BY_ID.get(look.shape)?.radii ?? null
const expressionOf = (look: BloubLook) => EXPRESSION_BY_ID.get(look.expression) ?? null

function modeFor(id: string): Mode {
  const p = useParticipants.getState().byId[id]
  if (!p) return 'idle'
  return modeOf(p, p.computerId ? useComputers.getState().byId[p.computerId] : undefined)
}

function frame() {
  raf = 0
  const now = clock()
  let drawn = false
  for (const bot of bots.values()) {
    const engine = bot.engine
    if (!engine || bot.visible === 0) continue
    const t = now + bot.offset
    advance(bot.head, t, (state, at) => engine.setState(state, at))
    // Reduced motion: each state is drawn once, settled, and nothing loops.
    const f = engine.sample(still() ? bot.head.since + 1 : t)
    for (const view of bot.views) if (view.visible) view.draw(f)
    drawn = true
  }
  if (drawn && !still()) raf = requestAnimationFrame(frame)
}

function wake() {
  if (!raf) raf = requestAnimationFrame(frame)
}

function play(bot: Bot, head: Playhead) {
  bot.head = head
  bot.engine?.setState(head.program.steps[0][0], head.since)
  wake()
}

function applyMode(bot: Bot) {
  bot.timer = 0
  if (bot.wanted === bot.mode) return
  const t = timeOf(bot)
  // Under reduced motion a turn neither opens with burst nor closes with comet.
  play(bot, { program: programFor(still() ? null : bot.mode, bot.wanted), index: 0, since: t })
  bot.mode = bot.wanted
  bot.appliedAt = t
}

function requestMode(bot: Bot, mode: Mode) {
  bot.wanted = mode
  if (bot.timer) return
  const wait = bot.appliedAt + MIN_HOLD - timeOf(bot)
  if (wait <= 0) applyMode(bot)
  else bot.timer = window.setTimeout(() => applyMode(bot), wait * 1000)
}

function posted(message: Message) {
  const bot = bots.get(message.authorId)
  if (!bot || !SPOKEN.has(message.kind) || still()) return
  // burst and comet already mark the turn; a wink would cut them short.
  const current = bot.head.program.steps[bot.head.index][0]
  if (current === 'burst' || current === 'comet') return
  play(bot, { program: flash(POSTED, bot.mode), index: 0, since: timeOf(bot) })
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  const sync = () => { for (const [id, bot] of bots) requestMode(bot, modeFor(id)) }
  useParticipants.subscribe((s, prev) => { if (s.byId !== prev.byId) sync() })
  useComputers.subscribe((s, prev) => { if (s.byId !== prev.byId) sync() })
  ws.on((e) => { if (e.type === 'message.new') posted(e.message) })
  reducedMotion?.addEventListener('change', wake)
}

/** Off-screen views (a scrolled-away row, a closed panel) are not drawn. */
const observed = new WeakMap<Element, (visible: boolean) => void>()
const watcher = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) observed.get(entry.target)?.(entry.isIntersecting)
  })
  : null

/** Starts animating `svg` as an avatar of `agentId` and returns the function
 *  that stops it. The agent's engine is created with its first view and
 *  dropped with its last. */
export function attach(agentId: string, svg: SVGSVGElement, look: BloubLook): () => void {
  wire()
  let bot = bots.get(agentId)
  if (!bot) {
    const offset = offsetOf(agentId)
    const mode = modeFor(agentId)
    const t = clock() + offset
    const created: Bot = {
      engine: null, offset, look, mode, wanted: mode, appliedAt: t, timer: 0, views: new Set(), visible: 0,
      head: { program: programFor(null, mode), index: 0, since: t },
    }
    bots.set(agentId, created)
    bot = created
    void loadEngine().then(({ BotEngine }) => {
      if (bots.get(agentId) !== created) return
      const { head } = created
      const engine = new BotEngine(RAYON, head.program.steps[head.index][0], shapeOf(created.look), expressionOf(created.look))
      // Start the state at the playhead's time, so a burst already half played is not replayed.
      engine.reset(head.program.steps[head.index][0], head.since)
      created.engine = engine
      wake()
    })
  }
  const owner = bot
  const view: View = { draw: createView(svg), visible: watcher === null }
  if (view.visible) owner.visible++
  owner.views.add(view)
  observed.set(svg, (visible) => {
    if (visible === view.visible) return
    view.visible = visible
    owner.visible += visible ? 1 : -1
    if (visible) wake()
  })
  watcher?.observe(svg)
  wake()
  return () => {
    watcher?.unobserve(svg)
    observed.delete(svg)
    if (view.visible) owner.visible--
    owner.views.delete(view)
    if (owner.views.size > 0) return
    window.clearTimeout(owner.timer)
    bots.delete(agentId)
  }
}

/** A new shape or face morphs in; the colour is CSS on each view. */
export function restyle(agentId: string, look: BloubLook): void {
  const bot = bots.get(agentId)
  if (!bot) return
  bot.look = look
  const t = timeOf(bot)
  bot.engine?.setShape(shapeOf(look), t)
  bot.engine?.setExpression(expressionOf(look), t)
  wake()
}

/** Draws one resting frame of a look into `svg`, for the picker. */
export function drawStill(svg: SVGSVGElement, shape: BloubLook['shape'], expression: BloubLook['expression']): () => void {
  let live = true
  const draw = createView(svg)
  void loadEngine().then(({ BotEngine }) => {
    // 1 s in: before the first scheduled blink, with the gaze near its rest.
    if (live) draw(new BotEngine(RAYON, 'idle', SHAPE_BY_ID.get(shape)?.radii ?? null, EXPRESSION_BY_ID.get(expression) ?? null).sample(1))
  })
  return () => { live = false }
}
