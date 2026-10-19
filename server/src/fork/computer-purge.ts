/**
 * Runs in the computer's daemon, which calls purgeDeletedAgents before every
 * agent sync (agents/computer/daemon.ts): removes what an agent deleted for
 * good (./purge.ts) left on this computer, then clears it from the server's
 * queue. Only Node builtins, like the rest of the daemon bundle.
 */
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The ids agents/create.ts makes. Anything else from the server is refused
 *  before it reaches a path. */
const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,99}$/

/** Claude Code keeps a project's transcripts in a folder named after its path,
 *  with every character but letters and digits turned into '-'. */
const claudeProjectName = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

/** The agent's home and engine sessions, at the paths the daemon gives them
 *  (CONFIG_DIR, AGENTS_ROOT and SESSIONS_DIR in daemon.ts), and Claude Code's
 *  transcripts of the home and its subfolders.
 *  ponytail: Codex threads live in the shared ~/.cumora/codex-runtime SQLite
 *  files, which Codex app-servers of other agents hold open, so their rows
 *  stay. Remove them with Codex's own tooling if it ever offers a delete. */
export async function removeAgentFiles(agentId: string, root = homedir(), claudeDir = process.env.CLAUDE_CONFIG_DIR || join(root, '.claude')): Promise<void> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error(`not an agent id: ${JSON.stringify(agentId)}`)
  const agents = join(root, '.cumora', 'agents')
  const home = join(agents, agentId)
  await rm(home, { recursive: true, force: true })
  await rm(join(root, '.cumora', 'sessions', agentId), { recursive: true, force: true })
  await rm(join(root, '.cumora', 'sessions', `${agentId}.session`), { force: true })

  // The name maps '/' and '-' alike, so `pr`'s folders share their prefix with
  // `pr-summary-bot`'s. Folders that belong to a home still on disk are kept.
  const base = claudeProjectName(home)
  const others = (await readdir(agents).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`${agentId}-`))
    .map((name) => claudeProjectName(join(agents, name)))
  const owns = (name: string, prefix: string) => name === prefix || name.startsWith(`${prefix}-`)
  const projects = join(claudeDir, 'projects')
  for (const name of await readdir(projects).catch(() => [] as string[])) {
    if (owns(name, base) && !others.some((other) => owns(name, other))) {
      await rm(join(projects, name), { recursive: true, force: true })
    }
  }
}

/** Never throws: a failure is logged and the agent stays queued for the next
 *  sync, so it cannot stop the daemon from managing the other agents. */
export async function purgeDeletedAgents(serverUrl: string, deviceToken: string, stopRunner: (agentId: string) => Promise<void>): Promise<void> {
  const headers = { Authorization: `Bearer ${deviceToken}` }
  let agentIds: string[]
  try {
    const res = await fetch(`${serverUrl}/api/fork/computers/me/purges`, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    agentIds = ((await res.json()) as { agentIds: string[] }).agentIds
  } catch (err) {
    console.warn('[computer] deleted agents list failed:', err instanceof Error ? err.message : err)
    return
  }
  for (const agentId of agentIds) {
    try {
      // A turn still running would write its transcript back.
      await stopRunner(agentId)
      await removeAgentFiles(agentId)
      const res = await fetch(`${serverUrl}/api/fork/computers/me/purges/${encodeURIComponent(agentId)}`, { method: 'DELETE', headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      console.log(`[computer] removed the files of deleted agent ${agentId}`)
    } catch (err) {
      console.warn(`[computer] removing the files of deleted agent ${agentId} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
