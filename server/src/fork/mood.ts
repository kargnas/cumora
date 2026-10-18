/**
 * Gives an agent's bloub avatar the face of what it just said. Every message
 * an agent that wears a bloub posts goes to TypeSafe Jev on OpenRouter, a
 * decision model that answers a typed question instead of writing text: here,
 * which face fits the feeling of the message. The face is stored with the look
 * (./store.ts) and sent to the workspace's clients as `fork.agent.mood`, and it
 * stays until the agent's next message.
 *
 * It listens on the same Redis channel the scheduler wakes agents from, so it
 * needs no change to upstream's message path, and like `fork.agent.tool`
 * (./agentTool.ts) it publishes straight to Redis, never to the Postgres outbox.
 */
import type { MessageNewEvent } from '../redis.js'
import { getForkStore } from './store.js'

/** OpenRouter serves Jev only on its decisions endpoint, not /chat/completions. */
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
/** Pinned: a newer Jev may pick other faces for the same messages. */
const MODEL = 'typesafe/jev-1.14'
/** A face that arrives seconds late is no longer about the message on screen. */
const TIMEOUT_MS = 5_000
/** Jev reads short state fastest, and a long report's opening carries its tone. */
const MAX_CHARS = 4_000
/** The messages that count as the agent speaking (the client's `SPOKEN` in src/next/bloub/director.ts). */
const SPOKEN = new Set(['text', 'attachment', 'email', 'poll'])

/** Jev follows an option's name more than its description, so the options are
 *  plain English words, each mapped to the client engine's expression id. */
const FACES = {
  calm: ['neutre', 'A plain, matter-of-fact message with no clear feeling: a status, a fact, an answer, a request.'],
  attentive: ['attentif', 'Focused and listening: it acknowledges a request, asks for a detail, or says it is looking into it.'],
  surprised: ['surpris', 'Surprised or caught off guard by something unexpected.'],
  excited: ['excite', 'Eager and enthusiastic, cannot wait to do something.'],
  happy: ['heureux', 'Glad, pleased or relieved: good news, a success, thanks.'],
  laughing: ['hilare', 'Laughing or joking; finds something funny.'],
  angry: ['colere', 'Angry, annoyed or frustrated.'],
  sad: ['triste', 'Sad, sorry or disappointed: bad news, a failure, an apology.'],
  scared: ['effraye', 'Worried or alarmed about a risk, a danger or a mistake.'],
  suspicious: ['mefiant', 'Doubtful or suspicious; does not believe a claim.'],
  confused: ['confus', 'Confused or lost; unsure what is meant.'],
  curious: ['curieux', 'Curious or intrigued; wants to explore an idea.'],
  proud: ['fier', 'Proud of its own work or result.'],
  shy: ['timide', 'Shy or bashful, for example after praise.'],
  unimpressed: ['blase', 'Bored or unimpressed; deadpan.'],
  sleepy: ['somnolent', 'Tired, sleepy, low on energy.'],
} as const satisfies Record<string, readonly [string, string]>

const INSTRUCTIONS = 'An AI teammate wrote this chat message. Which face shows the feeling the writer expresses in it? '
  + 'Judge the writer, not the topic. Pick calm when no clear feeling shows.'

/** The decisions request for one message. */
export function moodRequest(message: string) {
  return {
    model: MODEL,
    state: { message: message.slice(0, MAX_CHARS) },
    questions: {
      face: {
        type: 'choice',
        instructions: INSTRUCTIONS,
        criteria: Object.fromEntries(Object.entries(FACES).map(([name, [, description]]) => [name, description])),
      },
    },
  }
}

/** The expression id of the face Jev picked; null for an answer that names no offered face. */
export function faceOf(response: unknown): string | null {
  const choice = (response as { answers?: { face?: { choice?: unknown } } } | null)?.answers?.face?.choice
  return typeof choice === 'string' && Object.hasOwn(FACES, choice) ? FACES[choice as keyof typeof FACES][0] : null
}

/** Listens for agent messages. Called once, at boot, by the fork router. */
export function startMoods(): void {
  void listen().catch((err: unknown) => console.error('[fork] bloub moods did not start:', err))
}

async function listen(): Promise<void> {
  // Imported here: env.js exits without OPENAI_API_KEY, which would kill the tests.
  const { env } = await import('../env.js')
  const key = env.OPENROUTER_API_KEY
  if (!key) {
    console.warn('[fork] OPENROUTER_API_KEY is not set, so bloub faces stay at rest')
    return
  }
  const { redis, sub, CH_MESSAGE_NEW, CH_STATUS } = await import('../redis.js')

  const decide = async (body: string): Promise<string | null> => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kargn.as',
        'X-OpenRouter-Title': 'Sangrak',
      },
      body: JSON.stringify(moodRequest(body)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Jev answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return faceOf(await res.json())
  }

  /** Each agent's newest message, so a late answer for an older one never replaces its face. */
  const latest = new Map<string, string>()

  const mood = async ({ companyId, message }: MessageNewEvent): Promise<void> => {
    if (!companyId || !SPOKEN.has(message.kind) || !message.body.trim()) return
    const store = await getForkStore()
    // Only agents can wear a bloub, so this also skips people.
    if (!store.bloubAvatars(companyId)[message.authorId]) return
    // Redis delivers a message at least once, and every server instance hears it.
    if (await redis.set(`fork:mood:${message.id}`, '1', 'EX', 3600, 'NX') !== 'OK') return
    latest.set(message.authorId, message.id)
    const expression = await decide(message.body)
    if (!expression || latest.get(message.authorId) !== message.id) return
    if (!store.setBloubExpression(companyId, message.authorId, expression)) return
    await redis.publish(CH_STATUS, JSON.stringify({
      type: 'fork.agent.mood', companyId, participantId: message.authorId, expression,
    }))
  }

  sub.on('message', (channel, payload) => {
    if (channel !== CH_MESSAGE_NEW) return
    let event: MessageNewEvent
    try { event = JSON.parse(payload) as MessageNewEvent } catch { return }
    mood(event).catch((err: unknown) => console.warn('[fork] bloub mood failed:', err instanceof Error ? err.message : err))
  })
  // ws.ts subscribes this channel on the same connection; subscribing again is harmless.
  await sub.subscribe(CH_MESSAGE_NEW)
}
