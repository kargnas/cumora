/**
 * The shared memory index in every wake (fork/sharedMemory.ts). A computer
 * without one wakes its agents as before; with one, the index follows the
 * agent's own under its path, so the agent can open the files it points to,
 * and stays small, since every agent reads it on every wake.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSharedMemory } from '../fork/sharedMemory.js'

test('no shared memory leaves the agent\'s own digest as it was', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'shared-memory-'))
  t.after(() => rm(dir, { recursive: true }))
  assert.equal(await withSharedMemory('- [Own](own.md)', dir), '- [Own](own.md)')
})

test('the shared index follows the agent\'s own under its path, clipped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'shared-memory-'))
  t.after(() => rm(dir, { recursive: true }))
  const index = join(dir, 'MEMORY.md')
  await writeFile(index, '- [Owner](owner.md) — call him 상락님\n')
  assert.equal(
    await withSharedMemory('- [Own](own.md)', dir),
    `- [Own](own.md)\n\n## shared by every agent on this computer (\`${index}\`)\n- [Owner](owner.md) — call him 상락님`,
  )
  await writeFile(index, 'x'.repeat(5000))
  assert.ok((await withSharedMemory('', dir)).length < 2200)
})
