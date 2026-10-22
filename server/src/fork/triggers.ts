/**
 * Triggers: routines that fire when something happens instead of at a time.
 * The event so far is a pull request merging on GitHub.
 *
 * chat.zz.gg is on the tailnet only, so GitHub cannot call it: the server polls
 * instead, once a minute per (profile, repository), with a conditional request
 * so an unchanged list answers 304 and costs no rate limit. A merge fires once:
 * the fires table claims `pr:<number>` before its message is posted.
 *
 * The token is the computer's own: compose mounts its gh profiles
 * (computer/gh-profile.mjs in the deploy repo) read-only under GH_DIR, so a
 * trigger on an OP.GG repository reads it as the profile that may, and the
 * server keeps no token of its own.
 *
 * A fire posts the same system message as a Calendar dispatch, through
 * upstream's own `postDispatchMessage` (../calendar.ts), in the
 * `calendar_event` envelope with `eventKind: 'trigger'`: the daemon's and the
 * triage's alarm gates wake the assignee as they do for a routine, and the
 * clients keep it out of the transcript the same way. The pull request is the
 * event's description and the trigger's prompt its brief.
 *
 * People make triggers in the Routines tab (./router.ts), agents with
 * `cumora trigger` (runTriggerCli below), under the tab's rule: a room's
 * triggers are its members' business.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ParsedArgs } from '../agents/cli-parse.js'
import type { CliResult } from '../agents/cli-result.js'
import { inRoom } from './cards.js'
import { getForkStore, type Trigger } from './store.js'

const POLL_MS = 60_000
// Same convention as the recorder: relative to the server's cwd, where compose
// mounts the computer's gh profiles.
const GH_DIR = resolve(process.cwd(), 'server/computer/gh')
// The names gh-profile.mjs accepts.
export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/
export const MAX_TITLE = 120
export const MAX_PROMPT = 4000
// ponytail: one page of the newest closed pull requests per poll; more than
// this many merged within a minute lose the oldest. Page on if that happens.
const PAGE = 30

export interface MergedPr {
  number: number
  title: string
  url: string
  author: string
  base: string
  mergedAt: string
}

/** The github.com token in a gh profile's hosts.yml, or null when it has none.
 *  gh keeps the active user's token at the host's own level and repeats it per
 *  signed-in user in the `users:` map above it. */
export function tokenOf(hostsYaml: string): string | null {
  const host = hostsYaml.match(/^github\.com:\n((?:[ \t]+\S.*\n?)*)/m)?.[1]
  if (!host) return null
  return host.match(/^ {4}oauth_token:[ \t]*(\S+)/m)?.[1] ?? host.match(/^[ \t]+oauth_token:[ \t]*(\S+)/m)?.[1] ?? null
}

function profileToken(profile: string): string | null {
  try {
    return tokenOf(readFileSync(join(GH_DIR, profile, 'hosts.yml'), 'utf8'))
  } catch (err) {
    // A profile that never signed in has no hosts.yml; anything else is reported.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** The gh profiles on the computer that are signed in to github.com. */
export function listProfiles(): string[] {
  if (!existsSync(GH_DIR)) return []
  return readdirSync(GH_DIR).filter((name) => PROFILE_RE.test(name) && profileToken(name) !== null).sort()
}

interface GhPull {
  number: number
  title: string
  html_url: string
  merged_at: string | null
  user: { login: string } | null
  base: { ref: string }
}

// The ETag of the last list per (profile, repository): GitHub answers an
// unchanged list with 304, which it does not count against the rate limit.
const etags = new Map<string, string>()

/** The repository's newest merged pull requests as GitHub orders them (last
 *  update first), or null when the list has not changed since the last call.
 *  `fresh` asks for the list either way. */
export async function mergedPulls(profile: string, repo: string, fresh = false): Promise<MergedPr[] | null> {
  const token = profileToken(profile)
  if (!token) throw new Error(`gh profile ${profile} is not signed in to github.com`)
  const key = `${profile} ${repo}`
  const etag = fresh ? undefined : etags.get(key)
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'cumora-triggers',
      'x-github-api-version': '2022-11-28',
      ...(etag ? { 'if-none-match': etag } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 304) return null
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo} as ${profile}`)
  const tag = res.headers.get('etag')
  if (tag) etags.set(key, tag)
  const pulls = (await res.json()) as GhPull[]
  return pulls
    .filter((p) => p.merged_at !== null)
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? '', base: p.base.ref, mergedAt: p.merged_at as string }))
}

/** The pull requests a trigger fires for: those merged after it was made, in
 *  merge order, so a poll that finds several posts them as they happened. */
export function dueFor(trigger: Pick<Trigger, 'since'>, pulls: MergedPr[]): MergedPr[] {
  const since = Date.parse(trigger.since)
  return pulls.filter((p) => Date.parse(p.mergedAt) > since).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
}

function envelope(t: Trigger, pr: MergedPr): string {
  return JSON.stringify({
    kind: 'calendar_event',
    eventKind: 'trigger',
    triggerId: t.id,
    title: t.title,
    description: `Pull request #${pr.number} "${pr.title}" by ${pr.author} merged into ${pr.base} of ${t.repo} at ${pr.mergedAt}.\n${pr.url}`,
    agentPrompt: t.prompt,
    assigneeId: t.assigneeId,
    targetConversationId: t.conversationId,
    scheduledFor: pr.mergedAt,
    createdBy: t.createdBy,
  })
}

/** Posts the trigger's message for one pull request. False when that event
 *  fired before. Throws when posting failed, after recording why. */
export async function fire(t: Trigger, pr: MergedPr, eventKey = `pr:${pr.number}`): Promise<boolean> {
  const store = await getForkStore()
  if (!store.claimFire(t.id, eventKey, new Date().toISOString(), `#${pr.number} ${pr.title}`)) return false
  try {
    // Imported here, not at the top: calendar.js loads db/pool.js and env.ts (see router.ts).
    const { postDispatchMessage } = await import('../calendar.js')
    const messageId = await postDispatchMessage({
      event: { company_id: t.companyId, assignee_id: t.assigneeId },
      conversationId: t.conversationId,
      body: envelope(t, pr),
    })
    store.settleFire(t.id, eventKey, { messageId })
    return true
  } catch (err) {
    store.settleFire(t.id, eventKey, { error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/** Run now: fires the repository's latest merge as an event of its own, fired
 *  before or not. Null when the repository has no merged pull request. */
export async function runNow(t: Trigger): Promise<MergedPr | null> {
  const latest = dueFor({ since: '1970-01-01T00:00:00Z' }, (await mergedPulls(t.profile, t.repo, true)) ?? []).pop()
  if (!latest) return null
  await fire(t, latest, `manual:${Date.now()}`)
  return latest
}

// Why the last poll of a (profile, repository) failed, shown under its triggers
// so a revoked token or a renamed repository is not a silent stop. The same
// failure every minute is logged once.
const pollErrors = new Map<string, string>()

export function pollErrorOf(t: Pick<Trigger, 'profile' | 'repo'>): string | null {
  return pollErrors.get(`${t.profile} ${t.repo}`) ?? null
}

async function poll(): Promise<void> {
  const store = await getForkStore()
  const byRepo = new Map<string, Trigger[]>()
  for (const t of store.activeTriggers()) {
    const key = `${t.profile} ${t.repo}`
    byRepo.set(key, [...(byRepo.get(key) ?? []), t])
  }
  for (const [key, triggers] of byRepo) {
    let pulls: MergedPr[] | null
    try {
      pulls = await mergedPulls(triggers[0].profile, triggers[0].repo)
      pollErrors.delete(key)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (pollErrors.get(key) !== message) console.error(`[fork] trigger poll of ${key} failed:`, err)
      pollErrors.set(key, message)
      continue
    }
    if (!pulls) continue
    for (const t of triggers) {
      for (const pr of dueFor(t, pulls)) {
        try {
          await fire(t, pr)
        } catch (err) {
          console.error(`[fork] trigger ${t.id} (${t.title}) could not post #${pr.number}:`, err)
        }
      }
    }
  }
}

let started = false

export function startTriggerPoller(): void {
  if (started) return
  started = true
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await poll()
    } catch (err) {
      console.error('[fork] trigger poll failed:', err)
    } finally {
      busy = false
    }
  }
  setTimeout(() => void tick(), 10_000).unref()
  setInterval(() => void tick(), POLL_MS).unref()
}

/* ── Agent CLI ─────────────────────────────────────────────────────────── */

const USAGE = `usage: trigger list
       trigger create <convo_id> "<title>" --repo <owner/name> --profile <gh profile> --prompt "<what to do for each merge>" [--assignee <agent_id>]
       trigger delete <trigger_id>`

const HELP = `${USAGE}

A trigger wakes an agent in a room each time a pull request merges into any
branch of a GitHub repository, with the pull request and --prompt as its brief.
Use one instead of a polling loop, a background process or a cron job: the
server checks the repository once a minute as the gh profile you name
(\`gh-profile --list\`), only for merges after the trigger was made, and fires
each merge once. --assignee defaults to you and must be an agent in the room.
\`list\` shows the triggers of the rooms you are in, which people see and pause
in the room's Routines tab.`

function cliFail(text: string): CliResult {
  return { ok: false, text, exitCode: 1 }
}

function describe(t: Trigger): string {
  const fired = t.lastFire
    ? `fired ${t.fires}x, last for ${t.lastFire.label} at ${t.lastFire.at}${t.lastFire.error ? `, which failed: ${t.lastFire.error}` : ''}`
    : 'not fired yet'
  const pollError = pollErrorOf(t)
  return `${t.id} · ${t.status} · "${t.title}" · ${t.repo} as ${t.profile} · wakes @${t.assigneeId} in ${t.conversationId} · ${fired}` +
    (pollError ? `\n  polling fails: ${pollError}` : '') +
    `\n  prompt: ${t.prompt.replace(/\s+/g, ' ')}`
}

/** `cumora trigger`: the Routines tab's triggers for an agent, which sees,
 *  makes and deletes them only in rooms it is in. */
export async function runTriggerCli(parsed: ParsedArgs, me: string): Promise<CliResult> {
  if (parsed.flags.help) return { ok: true, text: HELP, exitCode: 0 }
  const [verb = 'list', ...args] = parsed.positional
  // Imported here, not at the top: db/pool.js loads env.ts (see fire above).
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ company_id: string }>(
    "SELECT company_id FROM participants WHERE id = $1 AND kind = 'agent' AND departed_at IS NULL",
    [me],
  )
  const companyId = rows[0]?.company_id
  if (!companyId) return cliFail(`unknown agent ${me}`)
  const store = await getForkStore()

  if (verb === 'list') {
    const { rows: rooms } = await pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM conversation_members WHERE company_id = $1 AND participant_id = $2',
      [companyId, me],
    )
    const triggers = rooms.flatMap((r) => store.triggers(companyId, r.conversation_id))
    return { ok: true, text: triggers.length ? triggers.map(describe).join('\n') : 'no triggers in your rooms', exitCode: 0 }
  }

  if (verb === 'create') {
    const [convoId, rawTitle] = args
    const flag = (name: string) => (typeof parsed.flags[name] === 'string' ? String(parsed.flags[name]).trim() : '')
    const title = (rawTitle ?? '').trim()
    const repo = flag('repo')
    const profile = flag('profile')
    const prompt = flag('prompt')
    const assigneeId = flag('assignee') || me
    if (!convoId || !title || !repo || !profile || !prompt) return cliFail(USAGE)
    if (title.length > MAX_TITLE) return cliFail(`the title must be at most ${MAX_TITLE} characters`)
    if (prompt.length > MAX_PROMPT) return cliFail(`the prompt must be at most ${MAX_PROMPT} characters`)
    if (!REPO_RE.test(repo)) return cliFail('--repo must be owner/name')
    const profiles = listProfiles()
    if (!profiles.includes(profile)) {
      return cliFail(`--profile must be a gh profile signed in on the computer: ${profiles.join(', ') || 'none is'}`)
    }
    if (!(await inRoom(companyId, me, convoId, 'agent'))) return cliFail(`you are not in ${convoId}`)
    if (!(await inRoom(companyId, assigneeId, convoId, 'agent'))) return cliFail(`${assigneeId} is not an agent in ${convoId}`)
    const t = store.createTrigger({ companyId, createdBy: me, conversationId: convoId, assigneeId, title, prompt, repo, profile })
    return { ok: true, text: `created ${t.id}: from now on, each pull request merged in ${repo} wakes @${assigneeId} in ${convoId}`, exitCode: 0 }
  }

  if (verb === 'delete') {
    const t = args[0] ? store.trigger(companyId, args[0]) : null
    if (!t || !(await inRoom(companyId, me, t.conversationId, 'agent'))) {
      return cliFail(`no trigger ${args[0] ?? ''} in your rooms; cumora trigger list shows them`)
    }
    store.deleteTrigger(companyId, t.id)
    return { ok: true, text: `deleted ${t.id} ("${t.title}")`, exitCode: 0 }
  }

  return cliFail(USAGE)
}
