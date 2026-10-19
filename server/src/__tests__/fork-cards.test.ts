/**
 * A sealed secret (fork/cards.ts) opens only with its key and for its own card,
 * and the computer's shim writes a taken secret into a new file without ever
 * printing it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openSecret, sealSecret } from '../fork/cards.js'
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

/** Runs the real shim for one command against a broker that answers `answer`. */
async function shim(argv: string[], answer: { text?: string; exitCode: number; file?: string }) {
  const run = mkdtempSync(join(dir, 'run-'))
  const file = join(run, 'cumora.js')
  writeFileSync(file, CUMORA_SHIM)
  const calls: string[][] = []
  const broker = new RuntimeCliBroker(join(run, 'ipc'), join(run, 'broker'), async (args) => { calls.push(args); return answer })
  await broker.start()
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string; calls: string[][] }>((resolve, reject) => {
      const child = spawn(process.execPath, [file, ...argv], { cwd: run, env: { ...process.env, CUMORA_AGENT_IPC_DIR: join(run, 'ipc') } })
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
  assert.deepEqual(r.calls, [['secret', 'take', 'm-1']], 'the path stays on the computer')
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
