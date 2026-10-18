/**
 * Records the standing files of the computer's agents into the fork store
 * for the Handbook (./handbook.ts): each agent's CLAUDE.md or AGENTS.md, its
 * memory and its own skills, and the skills every agent on the computer
 * shares. The computer keeps no history of these files, so this polls: every
 * STAT_MS it stats the files it knows, every SCAN_MS it lists the folders for
 * new ones, and it stores a version whenever a file's text differs from the
 * last one stored.
 *
 * compose mounts the agent homes and the shared skills read-only under
 * COMPUTER_DIR. An agent can write anything into its own home, so only the
 * whitelisted names are read, a path with a symlink anywhere in it is never
 * followed, and no path comes from a request.
 */
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, type Dirent,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { getForkStore, type ForkStore, type NewFileVersion } from './store.js'

// Same convention as FORK_DB_FILE in store.ts: relative to the server's cwd
// (/app in the image), where compose mounts the computer's folders.
const COMPUTER_DIR = resolve(process.cwd(), 'server/computer')
const AGENTS_DIR = join(COMPUTER_DIR, 'agents')
const SKILLS_DIR = join(COMPUTER_DIR, 'skills')
/** Scope of the shared skills; every other scope is an agent id. */
export const SHARED = ''

const STAT_MS = 5_000
const SCAN_MS = 60_000
export const MAX_FILE_BYTES = 256 * 1024
const MEMORY_DEPTH = 4
// Agent ids are slugs (agents/create.ts, onboardCompany.ts); the daemon names
// each home after its agent's id (agents/computer/daemon.ts).
export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i
// Names that cannot be stored as one line of a path.
const ODD_NAME = /[\p{Cc}\\]/u

export function computerMounted(): boolean {
  return existsSync(AGENTS_DIR) || existsSync(SKILLS_DIR)
}

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code
// A folder or file that is not there is normal (an agent without skills, a
// file deleted between the listing and the read); anything else is reported.
const isMissing = (err: unknown) => code(err) === 'ENOENT' || code(err) === 'ENOTDIR'

function entries(dir: string): Dirent[] {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir, { withFileTypes: true }) : []
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
}

interface FileRef { scope: string; path: string }

/** Every whitelisted file under the two roots. Dirent types do not follow
 *  symlinks, so a linked folder or file is skipped here. */
function listFiles(roots: { agents: string; skills: string }): FileRef[] {
  const out: FileRef[] = []
  for (const home of entries(roots.agents)) {
    if (!home.isDirectory() || !AGENT_ID.test(home.name)) continue
    const scope = home.name
    const dir = join(roots.agents, scope)
    for (const e of entries(dir)) {
      if (e.isFile() && (e.name === 'CLAUDE.md' || e.name === 'AGENTS.md')) out.push({ scope, path: e.name })
    }
    const walk = (rel: string, depth: number) => {
      for (const e of entries(join(dir, rel))) {
        if (ODD_NAME.test(e.name)) continue
        const path = `${rel}/${e.name}`
        if (e.isFile() && e.name.endsWith('.md')) out.push({ scope, path })
        else if (e.isDirectory() && depth < MEMORY_DEPTH) walk(path, depth + 1)
      }
    }
    walk('memory', 1)
    if (lstatOrNull(join(dir, '.claude'))?.isDirectory()) {
      for (const skill of entries(join(dir, '.claude', 'skills'))) {
        if (skill.isDirectory() && !ODD_NAME.test(skill.name)) out.push({ scope, path: `.claude/skills/${skill.name}/SKILL.md` })
      }
    }
  }
  for (const skill of entries(roots.skills)) {
    if (skill.isDirectory() && !ODD_NAME.test(skill.name)) out.push({ scope: SHARED, path: `${skill.name}/SKILL.md` })
  }
  return out
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/** Size and mtime of a regular file reached without a symlink, or null. */
function statFile(abs: string): { size: number; mtimeMs: number } | null {
  try {
    if (realpathSync(abs) !== abs) return null
    const st = lstatSync(abs)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/** The file's text. O_NOFOLLOW refuses a symlink swapped in after the stat,
 *  and O_NONBLOCK keeps a FIFO an agent made from blocking the server. */
function readText(abs: string): { text: string; size: number; mtimeMs: number } | null {
  let fd: number
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    if (isMissing(err) || code(err) === 'ELOOP') return null
    throw err
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    return { text: readFileSync(fd, 'utf8'), size: st.size, mtimeMs: st.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

interface Known extends FileRef {
  at: string
  /** Null after a deletion. */
  content: string | null
  /** Of the last read; -1 until the first one, so the file is read once. */
  size: number
  mtimeMs: number
}

const keyOf = (f: FileRef) => `${f.scope}\0${f.path}`

/** One poll of the computer's files. `roots` and `now` are for tests. */
export function createRecorder(store: ForkStore, roots = { agents: AGENTS_DIR, skills: SKILLS_DIR }, now = () => Date.now()) {
  const known = new Map<string, Known>()
  // Scopes with a recorded file. A file that shows up in a new scope (the
  // first poll ever, an agent's first turn) is a baseline; in a scope already
  // watched it is a new file, which is a change.
  const scopes = new Set<string>()
  for (const v of store.latestFileVersions()) {
    known.set(keyOf(v), { ...v, size: -1, mtimeMs: -1 })
    scopes.add(v.scope)
  }
  let lastScan = Number.NEGATIVE_INFINITY

  return function poll(): number {
    // A root that is not mounted says nothing about its files: they are not
    // deleted. Symlinks are judged against the real roots (on macOS a temp
    // folder sits behind /var -> /private/var).
    const mounted = { agents: existsSync(roots.agents), skills: existsSync(roots.skills) }
    const real = {
      agents: mounted.agents ? realpathSync(roots.agents) : roots.agents,
      skills: mounted.skills ? realpathSync(roots.skills) : roots.skills,
    }
    const inMount = (f: FileRef) => (f.scope === SHARED ? mounted.skills : mounted.agents)
    const absOf = (f: FileRef) => (f.scope === SHARED ? join(real.skills, f.path) : join(real.agents, f.scope, f.path))
    const candidates = new Map<string, FileRef>()
    for (const [key, k] of known) if (k.content !== null && inMount(k)) candidates.set(key, k)
    if (now() - lastScan >= SCAN_MS) {
      lastScan = now()
      for (const f of listFiles(real)) candidates.set(keyOf(f), f)
    }

    const found: Array<NewFileVersion & { size: number; mtimeMs: number }> = []
    for (const [key, f] of candidates) {
      const prev = known.get(key)
      const abs = absOf(f)
      const st = statFile(abs)
      if (!st) {
        if (prev?.content != null) {
          const at = new Date(now()).toISOString()
          // ponytail: a deletion is dated when a poll sees it, within STAT_MS;
          // one made while the server was down gets the time it came back.
          found.push({ scope: f.scope, path: f.path, at: at > prev.at ? at : prev.at, content: null, baseline: false, size: -1, mtimeMs: -1 })
        }
        continue
      }
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue
      if (st.size > MAX_FILE_BYTES) continue
      const read = readText(abs)
      if (!read) continue
      if (prev && prev.content === read.text) {
        prev.size = read.size
        prev.mtimeMs = read.mtimeMs
        continue
      }
      const mtime = new Date(read.mtimeMs).toISOString()
      found.push({
        scope: f.scope,
        path: f.path,
        // Versions of a file never go back in time, even when a copy keeps an
        // older mtime, so "the version at T" stays the newest at or before T.
        at: prev && prev.at > mtime ? prev.at : mtime,
        content: read.text,
        baseline: !prev && !scopes.has(f.scope),
        size: read.size,
        mtimeMs: read.mtimeMs,
      })
    }

    // Known state moves on only once the versions are on disk, so a failed
    // write is tried again on the next poll.
    store.recordFileVersions(found.map(({ size: _size, mtimeMs: _mtimeMs, ...v }) => v))
    for (const v of found) {
      known.set(keyOf(v), { scope: v.scope, path: v.path, at: v.at, content: v.content, size: v.size, mtimeMs: v.mtimeMs })
      scopes.add(v.scope)
    }
    return found.length
  }
}

let started = false

/** Starts polling for the life of the process, if compose mounted the
 *  computer's folders. The timer is unref'd, so it never keeps a process up. */
export function startRecorder(): void {
  if (started) return
  started = true
  let poll: ReturnType<typeof createRecorder> | null = null
  let busy = false
  let lastError = ''
  const tick = async () => {
    // Opening the store is the only await; a slow first open must not start
    // a second recorder over the same files.
    if (busy || !computerMounted()) return
    busy = true
    try {
      poll ??= createRecorder(await getForkStore())
      poll()
      lastError = ''
    } catch (err) {
      // The same failure every 5 seconds is logged once.
      const message = err instanceof Error ? err.message : String(err)
      if (message !== lastError) console.error('[fork] handbook recorder failed:', err)
      lastError = message
    } finally {
      busy = false
    }
  }
  void tick()
  setInterval(() => void tick(), STAT_MS).unref()
}
