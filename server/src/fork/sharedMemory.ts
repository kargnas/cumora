/**
 * Shared memory: what every agent on a computer needs to know, in one folder
 * all of them read and write beside their own `memory/`: who the people they
 * work for are, what to call them, the language and time zone they use, and
 * the accounts they all use. Without it each agent learns these in its own
 * conversations, and a new one knows none of them when it asks its first
 * question (./firstQuestion.ts).
 *
 * The daemon (agents/computer/daemon.ts) puts the folder's MEMORY.md into
 * every wake after the agent's own index, and its standing prompt carries
 * sharedMemoryPrompt. Agents write the files with their own tools, which reach
 * outside their homes only when the computer runs the engines unsandboxed
 * (CUMORA_BYOA_ALLOW_UNSANDBOXED, as cumora-setup's does). A sandboxed agent
 * gets the index and is told the folder is closed to it.
 *
 * ponytail: no lock; two agents rewriting the same file at once can lose one
 * edit. The prompt asks them to change only their own lines; add a lock (or one
 * owner per file) if lost edits show up.
 *
 * Kept free of server imports: the daemon bundle includes it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clipMemoryDigest, DEFAULT_MEMORY_DIGEST_CHARS } from '../agents/memory-scope.js'

/** Beside the agent homes in ~/.cumora/agents. */
export const SHARED_MEMORY_DIR = join(homedir(), '.cumora', 'shared-memory')
// Every agent pays for the index on every wake, so it gets half of what an
// agent's own index may take.
export const SHARED_INDEX_CHARS = DEFAULT_MEMORY_DIGEST_CHARS / 2

/** The standing prompt's paragraph on the shared memory. `writable`: the
 *  engines run unsandboxed, so the agent's tools reach the folder. */
export function sharedMemoryPrompt(writable: boolean): string {
  if (!writable) {
    return (
      `Shared memory: the shared index after your own memory index is \`${SHARED_MEMORY_DIR}/MEMORY.md\`, ` +
      `the memory every agent on this computer shares. Your tools cannot open or change that folder here, ` +
      `so take the index as it is.\n\n`
    )
  }
  return (
    `Shared memory: \`${SHARED_MEMORY_DIR}/\` is the memory every agent on this computer shares, and its ` +
    `\`MEMORY.md\` comes into every wake after your own index. It is the one place outside your home you may ` +
    `read and write, an exception to the privacy rules in your CLAUDE.md or AGENTS.md and below. Keep there ` +
    `only what every agent needs: who the people you work for are, what to call them, the language and time ` +
    `zone they use, and which accounts you all use (never a password, token or key). What belongs to one room ` +
    `or project, and your own role and work, stay in \`memory/\`. Keep it the way you keep your own memory ` +
    `(one fact per file, rewritten in place, a one-line pointer in its MEMORY.md), and change only the lines ` +
    `you mean to, since other agents edit it too.\n\n`
  )
}

/** An agent's memory digest followed by the shared index, when there is one. */
export async function withSharedMemory(own: string, dir = SHARED_MEMORY_DIR): Promise<string> {
  const file = join(dir, 'MEMORY.md')
  let index = ''
  try {
    index = clipMemoryDigest(await readFile(file, 'utf8'), SHARED_INDEX_CHARS)
  } catch (err) {
    // No shared memory yet is how every computer starts. Any other failure is
    // logged, and the wake goes on with the agent's own memory.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[computer] cannot read the shared memory index ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!index) return own
  const shared = `## shared by every agent on this computer (\`${file}\`)\n${index}`
  return own ? `${own}\n\n${shared}` : shared
}
