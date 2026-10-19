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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getForkStore, type Trigger } from './store.js'

const POLL_MS = 60_000
// Same convention as the recorder: relative to the server's cwd, where compose
// mounts the computer's gh profiles.
const GH_DIR = resolve(process.cwd(), 'server/computer/gh')
// The names gh-profile.mjs accepts.
export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/
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
