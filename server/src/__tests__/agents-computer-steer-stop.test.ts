/**
 * Same-turn steering and stopping for the persistent Claude and Codex sessions.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-steer-stop.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { autoStopsTurn } from '../agents/computer/daemon.js'
import { type EngineSession, getAdapter } from '../agents/computer/engine.js'
import { parseInterruptData } from '../agents/runtime/wake-options.js'

const IS_WIN = process.platform === 'win32'
const original = { ...process.env }
const tempDirs: string[] = []
const liveSessions: EngineSession[] = []

afterEach(async () => {
  for (const s of liveSessions.splice(0)) { try { await s.stop({ force: true }) } catch { /* already gone */ } }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A temp HOME with a fake engine CLI first on PATH. */
async function fakeEngine(name: 'claude' | 'codex', source: string) {
  const root = await mkdtemp(join(tmpdir(), `cumora-steer-${name}-`))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  await writeFile(join(binDir, name), `#!/usr/bin/env node\n${source}`, 'utf8')
  await chmod(join(binDir, name), 0o755)
  process.env.HOME = root
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  const logs: string[] = []
  const session = getAdapter(name).startSession!({ home, env: { ...process.env }, onLog: (l) => logs.push(l) })
  assert.ok(session, `${name} must start a persistent session`)
  liveSessions.push(session)
  return { session, logs }
}

async function waitForLog(logs: string[], pattern: RegExp): Promise<void> {
  // 10 s: under the full suite, files run in parallel and a node child can take
  // seconds to start.
  for (let i = 0; i < 1_000; i += 1) {
    if (logs.some((l) => pattern.test(l))) return
    await delay(10)
  }
  assert.fail(`no log line matched ${pattern}: ${logs.join('\n')}`)
}

// ── Claude: stream-json input with command_lifecycle frames ────────────────

/** Fake `claude -p --input-format stream-json`. Every send() prompt starts a
 *  turn (system/init); a uuid-stamped message is a steer; FAKE_SCENARIO says
 *  what the CLI does with it. */
const FAKE_CLAUDE = String.raw`
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const caps = (process.env.FAKE_CAPS || '').split(',').filter(Boolean)
const scenario = process.env.FAKE_SCENARIO
const init = () => out({ type: 'system', subtype: 'init', session_id: 's1', capabilities: caps })
let prompts = 0
let steer = null
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.type === 'control_request') {
    process.stderr.write('INTERRUPT ' + JSON.stringify(m.request) + '\n')
    if (steer && m.request.cancel_queued === true) out({ type: 'command_lifecycle', command_uuid: steer, state: 'cancelled' })
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } })
    // A stop between turns (carry: the turn ended, its steer still queued) has no turn to end.
    if (scenario !== 'carry' || !steer) out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1' })
    return
  }
  if (m.uuid) {
    process.stderr.write('STEER ' + m.message.content[0].text + '\n')
    steer = m.uuid
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued' })
    if (scenario === 'fold') {
      out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started' })
      out({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } })
    } else if (scenario === 'carry') {
      out({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } })
    } else if (scenario === 'follow-up') {
      out({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } })
      init()
      out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started' })
      out({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 2, output_tokens: 3 } })
    }
    return
  }
  prompts += 1
  init()
  if (prompts > 1) out({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 7, output_tokens: 1 } })
  else if (scenario === 'no-caps') setTimeout(() => out({ type: 'result', subtype: 'success', session_id: 's1' }), 300)
})
`

async function claudeSession(scenario: string, caps = 'msg_lifecycle_v1,interrupt_cancel_queued_v1') {
  process.env.FAKE_SCENARIO = scenario
  process.env.FAKE_CAPS = caps
  return fakeEngine('claude', FAKE_CLAUDE)
}

test('claude steer is written at once and reports delivery when its lifecycle starts', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('fold')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  const result = await turn
  assert.equal(result.exitCode, 0)
  assert.equal(delivered, true)
  // The fake writes STEER to stderr and the result to stdout; the two pipes
  // can arrive in either order, so the line may land after the turn settles.
  await waitForLog(logs, /^STEER ping$/)
})

test('claude turn absorbs the follow-up turn a queued steer starts', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('follow-up')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  const result = await turn
  assert.equal(delivered, true)
  assert.equal(result.usage?.input_tokens, 3)
  assert.equal(result.usage?.output_tokens, 4)
  // The follow-up turn's result settled the first send(), not the next one.
  const next = await session.send('again')
  assert.equal(next.usage?.input_tokens, 7)
})

test('claude interrupt sends cancel_queued and settles the turn as interrupted', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('interrupt')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  await waitForLog(logs, /"state":"queued"/)
  await session.interrupt!()
  const result = await turn
  assert.equal(result.exitCode, 0)
  assert.equal(result.interrupted, true)
  assert.equal(result.error, undefined)
  assert.equal(delivered, false)
  // stderr, like STEER above: it may land after the turn settles.
  await waitForLog(logs, /^INTERRUPT .*"cancel_queued":true/)
})

test('claude steer without msg_lifecycle_v1 writes nothing', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('no-caps', 'interrupt_receipt_v1')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  const result = await turn
  assert.equal(result.exitCode, 0)
  assert.equal(delivered, undefined)
  assert.ok(!logs.some((l) => l.startsWith('STEER')))
})

test('a claude turn that waits on a queued steer settles when a stop cancels it', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('carry')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  await waitForLog(logs, /"type":"result"/)
  await session.interrupt!()
  const result = await turn
  assert.equal(result.interrupted, true)
  assert.equal(delivered, false)
})

test('claude steer during a stop is not written', { skip: IS_WIN }, async () => {
  const { session, logs } = await claudeSession('carry')
  const turn = session.send('wake')
  await waitForLog(logs, /"subtype":"init"/)
  const stopping = session.interrupt!()
  let delivered: boolean | undefined
  session.steer('late', (d) => { delivered = d })
  assert.equal(delivered, false)
  assert.ok(!logs.some((l) => l === 'STEER late'))
  await stopping.catch(() => {})
  void turn
})

// ── Codex: app-server JSON-RPC ─────────────────────────────────────────────

/** Fake `codex app-server --listen stdio://`. Like Codex, it runs an MCP server
 *  and every model command in process groups of their own; a turn's command
 *  starts a moment after the turn, then the reasoning item completes. */
const FAKE_CODEX = String.raw`
const { spawn } = require('node:child_process')
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const item = (method, value) => out({ method, params: { item: value } })
const mcp = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
process.stderr.write('MCP_PID ' + mcp.pid + '\n')
let cmdTimer
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (line.trim()) onMessage(JSON.parse(line))
  }
})
function onMessage(m) {
  if (m.method === 'initialize') return out({ id: m.id, result: {} })
  if (m.method === 'thread/start' || m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: 'th1' } } })
  if (m.method === 'turn/start') {
    // FAKE_TURN_DELAY: answer turn/start late, as a busy app-server does.
    setTimeout(() => {
      out({ id: m.id, result: { turn: { id: 'tu1' } } })
      item('item/started', { type: 'userMessage', content: m.params.input })
    }, Number(process.env.FAKE_TURN_DELAY || 0))
    cmdTimer = setTimeout(() => {
      // A command that ignores SIGTERM, so only SIGKILL ends it.
      const cmd = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      process.stderr.write('CMD_PID ' + cmd.pid + '\n')
      item('item/started', { type: 'commandExecution', command: 'long job' })
      item('item/completed', { type: 'reasoning' })
    }, 300 + Number(process.env.FAKE_TURN_DELAY || 0))
    return
  }
  if (m.method === 'turn/steer') {
    if (process.env.FAKE_STEER === 'reject') {
      out({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } })
    } else {
      out({ id: m.id, result: { turnId: 'tu1' } })
      item('item/started', { type: 'userMessage', content: m.params.input })
    }
    out({ method: 'turn/completed', params: { turn: { id: 'tu1', status: 'completed' } } })
    return
  }
  if (m.method === 'turn/interrupt') {
    clearTimeout(cmdTimer) // an interrupted turn starts no further tool call
    out({ id: m.id, result: {} })
    out({ method: 'turn/completed', params: { turn: { id: 'tu1', status: 'interrupted' } } })
  }
}
setInterval(() => {}, 1 << 30)
`

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A turn settles right after its command gets SIGKILL, and kill(pid, 0) finds
 *  the command until its parent reaps it, which can take a moment on a busy
 *  runner. 500 ms stays well under terminateTurnGroups' 1 s SIGTERM grace, so a
 *  turn that settled before the SIGKILL still fails here. The deadline is wall
 *  clock: counted sleeps would stretch on a busy runner, past the grace. */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 500
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await delay(10)
  }
  return true
}

async function pidFromLog(logs: string[], tag: 'CMD_PID' | 'MCP_PID'): Promise<number> {
  await waitForLog(logs, new RegExp(`^${tag} \\d+`))
  return Number(logs.find((l) => l.startsWith(tag))!.split(' ')[1])
}

const commandPid = (logs: string[]) => pidFromLog(logs, 'CMD_PID')

test('codex steer is sent while a command runs and reports delivery from the userMessage item', { skip: IS_WIN }, async () => {
  const { session, logs } = await fakeEngine('codex', FAKE_CODEX)
  const turn = session.send('wake')
  await commandPid(logs)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  const result = await turn
  assert.equal(result.exitCode, 0)
  assert.equal(delivered, true)
})

test('a rejected codex steer does not fail the pending turn', { skip: IS_WIN }, async () => {
  process.env.FAKE_STEER = 'reject'
  const { session, logs } = await fakeEngine('codex', FAKE_CODEX)
  const turn = session.send('wake')
  await commandPid(logs)
  let delivered: boolean | undefined
  session.steer('ping', (d) => { delivered = d })
  const result = await turn
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(delivered, false)
})

test('codex interrupt ends the turn and kills the command it started, not the MCP server', { skip: IS_WIN }, async () => {
  const { session, logs } = await fakeEngine('codex', FAKE_CODEX)
  const turn = session.send('wake')
  const mcp = await pidFromLog(logs, 'MCP_PID')
  const pid = await commandPid(logs)
  assert.ok(alive(pid))
  await session.interrupt!()
  const result = await turn
  assert.equal(result.exitCode, 0)
  assert.equal(result.interrupted, true)
  // Settled only once the command is gone, so a rerun cannot overlap it.
  assert.equal(await gone(pid), true, 'the command Codex left running must be dead when the turn settles')
  assert.equal(alive(mcp), true, 'a process group from before the turn must survive')
})

test('a codex stop that comes before turn/start answers still stops the turn', { skip: IS_WIN }, async () => {
  process.env.FAKE_TURN_DELAY = '400'
  const { session, logs } = await fakeEngine('codex', FAKE_CODEX)
  const turn = session.send('wake')
  await delay(50)
  await session.interrupt!()
  const result = await turn
  assert.equal(result.interrupted, true)
  const started = logs.find((l) => l.startsWith('CMD_PID'))
  if (started) assert.equal(await gone(Number(started.split(' ')[1])), true)
})

// ── Daemon rules ──────────────────────────────────────────────────────────

test('only a person writing to the agent can stop its busy turn', () => {
  assert.equal(autoStopsTurn({ author_kind: 'human', conversation_kind: 'direct', body: 'hi' }, 'hertz'), true)
  assert.equal(autoStopsTurn({ author_kind: 'human', conversation_kind: 'group', body: 'ping @hertz now' }, 'hertz'), true)
  assert.equal(autoStopsTurn({ author_kind: 'human', conversation_kind: 'group', body: 'ping @monk now' }, 'hertz'), false)
  assert.equal(autoStopsTurn({ author_kind: 'agent', conversation_kind: 'direct', body: '@hertz' }, 'hertz'), false)
  assert.equal(autoStopsTurn({ author_kind: 'human', conversation_kind: 'group', body: 'ask @dev-ops' }, 'dev'), false)
  assert.equal(autoStopsTurn({ author_kind: 'human', conversation_kind: 'group', body: '@dev, look' }, 'dev'), true)
})

test('an interrupt payload needs a room and a name', () => {
  assert.deepEqual(parseInterruptData(JSON.stringify({ conversationId: 'direct-1', byName: ' Sangrak ' })), { conversationId: 'direct-1', byName: 'Sangrak' })
  assert.equal(parseInterruptData(JSON.stringify({ conversationId: 'direct-1' })), null)
  assert.equal(parseInterruptData(JSON.stringify({ byName: 'Sangrak' })), null)
  assert.equal(parseInterruptData('not json'), null)
})
