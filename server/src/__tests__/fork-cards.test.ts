/**
 * A sealed secret (fork/cards.ts) opens only with its key and for its own card,
 * only the computer's shim may take one, and the shim writes it into a file it
 * created before asking, without ever printing it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openSecret, runCardCli, sealSecret } from '../fork/cards.js'
import { parseArgs } from '../agents/cli-parse.js'
import { CUMORA_SHIM, RuntimeCliBroker } from '../agents/computer/daemon.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-cards-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('a sealed secret opens only with its key, for its own card, untouched', () => {
  const key = randomBytes(32)
  const sealed = sealSecret(key, 'm-1', 'sk-live-123')
  assert.ok(!Buffer.from(sealed, 'base64').includes('sk-live-123'))
  assert.equal(openSecret(key, 'm-1', sealed).toString('utf8'), 'sk-live-123')
  assert.throws(() => openSecret(key, 'm-2', sealed), 'another card cannot open it')
  assert.throws(() => openSecret(randomBytes(32), 'm-1', sealed), 'another key cannot open it')
  const raw = Buffer.from(sealed, 'base64')
  raw[raw.length - 1] ^= 1
  assert.throws(() => openSecret(key, 'm-1', raw.toString('base64')), 'a changed byte is caught')
})

test('only the shim that saves a take into a file may take a secret', async () => {
  // A path means a shim that would print the empty text, and so does a take
  // without the shim's flag (the pod's curl shim, cumora run by hand).
  for (const argv of [['take', 'm-1'], ['take', 'm-1', '/tmp/key'], ['take', 'm-1', '--shim-file=yes']]) {
    const r = await runCardCli('secret', parseArgs(argv), 'bot')
    assert.equal(r.ok, false, argv.join(' '))
    assert.match(r.text, /only the computer's cumora shim/)
    assert.equal(r.file, undefined)
  }
})

/** Runs the real shim for one command against a broker that answers `answer`. */
async function shim(argv: string[], answer: { text?: string; exitCode: number; file?: string }, home?: string) {
  const run = mkdtempSync(join(dir, 'run-'))
  const file = join(run, 'cumora.js')
  writeFileSync(file, CUMORA_SHIM)
  const calls: string[][] = []
  const broker = new RuntimeCliBroker(join(run, 'ipc'), join(run, 'broker'), async (args) => { calls.push(args); return answer })
  await broker.start()
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string; calls: string[][] }>((resolve, reject) => {
      const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(run, 'ipc'), ...(home ? { HOME: home } : {}) }
      const child = spawn(process.execPath, [file, ...argv], { cwd: run, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr, calls }))
    })
  } finally {
    broker.stop()
  }
}

test('secret take writes the secret into a new file and prints only where it went', { timeout: 10_000 }, async () => {
  const secret = 'sk-live-should-never-print'
  const target = join(dir, 'keys', 'openai.key')
  const r = await shim(['secret', 'take', 'm-1', target], { text: '', exitCode: 0, file: Buffer.from(secret).toString('base64') })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(r.calls, [['secret', 'take', 'm-1', '--shim-file']], 'the path stays on the computer')
  assert.equal(readFileSync(target, 'utf8'), secret)
  assert.equal(statSync(target).mode & 0o777, 0o600)
  assert.match(r.stdout, /saved the secret to .*openai\.key/)
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret))

  // An existing file is refused before the server is asked, so the secret is never spent on it.
  const again = await shim(['secret', 'take', 'm-1', target], { text: '', exitCode: 0, file: Buffer.from(secret).toString('base64') })
  assert.equal(again.code, 1)
  assert.deepEqual(again.calls, [])
  assert.match(again.stderr, /exists/)
})

test('secret take asks only when it can write the file, and leaves none when nothing came', { timeout: 10_000 }, async () => {
  const waiting = join(dir, 'keys', 'waiting.key')
  const r = await shim(['secret', 'take', 'm-2', waiting], { text: 'nobody has sent the secret for m-2 yet', exitCode: 1 })
  assert.equal(r.code, 1)
  assert.equal(r.calls.length, 1)
  assert.ok(!existsSync(waiting), 'the file made for it is gone again')

  // The Handbook records .md files, and an unwritable folder would fail after
  // the server forgot the secret: both are refused before asking.
  const md = await shim(['secret', 'take', 'm-3', 'memory/token.md'], { text: '', exitCode: 0, file: 'eA==' })
  assert.equal(md.code, 64)
  assert.deepEqual(md.calls, [])
  const locked = join(dir, 'locked')
  mkdirSync(locked, { mode: 0o500 })
  try {
    const denied = await shim(['secret', 'take', 'm-4', join(locked, 'x.key')], { text: '', exitCode: 0, file: 'eA==' })
    assert.equal(denied.code, 1)
    assert.deepEqual(denied.calls, [])
    assert.match(denied.stderr, /cannot create/)
  } finally {
    chmodSync(locked, 0o700)
  }
})

test('a quoted ~ path lands in the home, not under the working folder', { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(dir, 'home-'))
  const r = await shim(['secret', 'take', 'm-5', '~/.secrets/openai'], { text: '', exitCode: 0, file: Buffer.from('sk-home').toString('base64') }, home)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(readFileSync(join(home, '.secrets', 'openai'), 'utf8'), 'sk-home')
  assert.equal(statSync(join(home, '.secrets')).mode & 0o777, 0o700)
})

test('a take in flight still saves its file when the command is stopped', { timeout: 10_000 }, async () => {
  const run = mkdtempSync(join(dir, 'run-'))
  const file = join(run, 'cumora.js')
  writeFileSync(file, CUMORA_SHIM)
  const target = join(run, 'stopped.key')
  let child: ChildProcess | undefined
  // The daemon has the request, and the server would forget the secret now.
  const broker = new RuntimeCliBroker(join(run, 'ipc'), join(run, 'broker'), async () => {
    child?.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { text: '', exitCode: 0, file: Buffer.from('sk-stopped').toString('base64') }
  })
  await broker.start()
  try {
    child = spawn(process.execPath, [file, 'secret', 'take', 'm-6', target], { cwd: run, env: { ...process.env, CUMORA_AGENT_IPC_DIR: join(run, 'ipc') } })
    const code = await new Promise<number | null>((resolve) => child?.on('close', resolve))
    assert.equal(code, 0)
    assert.equal(readFileSync(target, 'utf8'), 'sk-stopped')
  } finally {
    broker.stop()
  }
})
