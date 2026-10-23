/**
 * Shared memory: what every agent on a computer needs to know, in one folder
 * all of them read and write beside their own `memory/`: who the people they
 * work for are, what to call them, the language and time zone they use, and
 * the accounts and setup they all use. Without it each agent learns these in
 * its own conversations, and a new one knows none of them when it asks its
 * first question (./firstQuestion.ts).
 *
 * The daemon (agents/computer/daemon.ts) puts the folder's MEMORY.md into
 * every wake after the agent's own index, and its standing prompt carries
 * SHARED_MEMORY_PROMPT. Agents write the files with their own tools, which
 * reach outside their homes because cumora-setup's computer runs the engines
 * unsandboxed (CUMORA_BYOA_ALLOW_UNSANDBOXED); a sandboxed engine still gets
 * the index but cannot write the folder.
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
import { clipMemoryDigest } from '../agents/memory-scope.js'

/** Beside the agent homes in ~/.cumora/agents. */
export const SHARED_MEMORY_DIR = join(homedir(), '.cumora', 'shared-memory')
// Every agent pays for the index on every wake, so it gets half of what an
// agent's own index may take (DEFAULT_MEMORY_DIGEST_CHARS).
const MAX_CHARS = 2000

export const SHARED_MEMORY_PROMPT =
  `Shared memory: \`${SHARED_MEMORY_DIR}/\` is the memory every agent on this computer shares, and its ` +
  `\`MEMORY.md\` comes into every wake after your own index. It is the one folder outside your home you may ` +
  `read and write. Keep there what every agent needs: who the people you work for are, what to call them, ` +
  `the language and time zone they use, and the accounts and setup you all use; your own role and work stay ` +
  `in \`memory/\`. Keep it the way you keep your own memory (one fact per file, rewritten in place, a one-line ` +
  `pointer in its MEMORY.md), and change only the lines you mean to, since other agents edit it too.\n\n`

/** An agent's memory digest followed by the shared index, when there is one. */
export async function withSharedMemory(own: string, dir = SHARED_MEMORY_DIR): Promise<string> {
  const file = join(dir, 'MEMORY.md')
  let index = ''
  try {
    index = clipMemoryDigest(await readFile(file, 'utf8'), MAX_CHARS)
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
