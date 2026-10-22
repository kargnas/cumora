/**
 * Cards: what an agent asks a person under its own message. `cumora ask`
 * offers options to pick from, `cumora secret request` asks for a secret (an
 * API key, a token, a password). The question is an ordinary message the agent
 * posts through `cumora reply`, and the card is the fork store's row for it
 * (./store.ts), which the Next UI draws under the message
 * (src/next/chat/AskCard.tsx). A person's answer is posted as their own reply
 * quoting the question, so it reaches the agent like any reply, and the card
 * keeps showing it.
 *
 * A secret never enters a message, a log or the agent's transcript. It stays
 * sealed in the fork store until the agent runs `cumora secret take
 * <message_id> <path>`, once: the CLI result carries it to the computer's
 * `cumora` shim, which writes it into <path> instead of printing it
 * (agents/computer/daemon.ts), and the store forgets it.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import type { ParsedArgs } from '../agents/cli-parse.js'
import type { CliResult } from '../agents/cli-result.js'
import { getForkStore, type Card, type ForkStore } from './store.js'

export const MAX_QUESTION = 280
export const MAX_OPTIONS = 8
export const MAX_OPTION = 120
export const MAX_SECRET_BYTES = 16 * 1024

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/* ── Sealing ───────────────────────────────────────────────────────────── */

/** AES-256-GCM with the card's message id as associated data, so a sealed
 *  value opens only for its own card. Layout: 12-byte IV, 16-byte tag, text. */
export function sealSecret(key: Buffer, messageId: string, value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(messageId))
  const text = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), text]).toString('base64')
}

export function openSecret(key: Buffer, messageId: string, sealed: string): Buffer {
  const raw = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)).setAAD(Buffer.from(messageId))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
}

/** Derived from AGENT_RUNTIME_SECRET, like the upload signatures (storage.ts),
 *  so a deployment needs no extra secret and the two uses stay apart. */
async function secretKey(): Promise<Buffer> {
  // Imported here: env.js exits without OPENAI_API_KEY, which kills the tests.
  const { env } = await import('../env.js')
  return createHmac('sha256', env.AGENT_RUNTIME_SECRET).update('cumora:fork-secret-card').digest()
}

/* ── Agent CLI ─────────────────────────────────────────────────────────── */

const ASK_USAGE = 'usage: ask <convo_id> "<question>" "<option>" "<option>" [...] [--body "<text above the question>"]'
const SECRET_USAGE = 'usage: secret request <convo_id> "<what it is for>" [--body "<text above it>"]\n       secret take <message_id> <path>'

const ASK_HELP = `${ASK_USAGE}

Asks the people in the room to pick one option. The question goes out as your
message with the options under it, and the first person to pick closes it. Their
pick comes back as their reply quoting your question. --body puts more text
above the question, in the same message. --continue and --send-anyway work as
in \`cumora reply\`.`

const SECRET_HELP = `${SECRET_USAGE}

Never ask for a secret (an API key, a token, a password) in chat. \`secret
request\` posts what it is for with a field for it under your message. When a
person sends it, their reply quotes your request; then \`secret take\` saves it
into <path> on this computer (a new file, mode 600) and the server forgets it,
so you can take it once. Pick a path outside git work trees and outside
memory/, such as ~/.secrets/<name>, and never commit the file; a .md path is
refused because the Handbook records .md files. Use it from the file: never
print it or cat it.`

export function fail(text: string, exitCode = 1): CliResult {
  return { ok: false, text, exitCode }
}

export async function runCardCli(sub: 'ask' | 'secret', parsed: ParsedArgs, me: string): Promise<CliResult> {
  if (sub === 'ask') return parsed.flags.help ? { ok: true, text: ASK_HELP, exitCode: 0 } : ask(parsed, me, 'choice')
  const verb = parsed.positional[0]
  if (verb === 'request') return ask({ ...parsed, positional: parsed.positional.slice(1), literalFrom: shift(parsed.literalFrom) }, me, 'secret')
  if (verb === 'take') return take(parsed, me)
  return parsed.flags.help ? { ok: true, text: SECRET_HELP, exitCode: 0 } : fail(SECRET_USAGE)
}

function shift(literalFrom: number | undefined): number | undefined {
  return literalFrom === undefined ? undefined : literalFrom - 1
}

/** `ask` and `secret request`: posts the question as the agent's reply, then
 *  attaches the card to that message. The reply's own gates (a held reply, a
 *  monologue) apply as usual, and nothing is attached when it does not post. */
async function ask(parsed: ParsedArgs, me: string, kind: Card['kind']): Promise<CliResult> {
  const { unescapeChat } = await import('../agents/cli-parse.js')
  const end = parsed.literalFrom ?? parsed.positional.length
  const [convoId, rawQuestion, ...rawOptions] = parsed.positional.slice(0, end)
  // Text after a POSIX `--` came from the shim's --file/--stdin and is taken
  // verbatim; flag and positional text came through a shell.
  const above = parsed.literalFrom !== undefined
    ? parsed.positional.slice(parsed.literalFrom).join(' ').trim()
    : typeof parsed.flags.body === 'string' ? unescapeChat(parsed.flags.body).trim() : ''
  const usage = kind === 'choice' ? ASK_USAGE : SECRET_USAGE
  const question = unescapeChat(rawQuestion ?? '').trim()
  if (!convoId || !question) return fail(usage)
  if (question.length > MAX_QUESTION) return fail(`the question must be at most ${MAX_QUESTION} characters`)
  const options = rawOptions.map((o) => unescapeChat(o).trim())
  if (kind === 'choice') {
    if (options.length < 2 || options.length > MAX_OPTIONS) return fail(`give 2 to ${MAX_OPTIONS} options\n${usage}`)
    if (options.some((o) => !o || o.length > MAX_OPTION)) return fail(`each option must be 1 to ${MAX_OPTION} characters`)
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return fail('the options must differ')
  } else if (options.length > 0) {
    return fail(usage)
  }

  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ kind: string }>('SELECT kind FROM conversations WHERE id = $1', [convoId])
  if (rows[0]?.kind === 'email') return fail('cards work in chat rooms, not in email threads')

  const line = kind === 'secret' ? `🔑 ${question}` : question
  const body = above ? `${above}\n\n${line}` : line
  const replyFlags = [
    ...(parsed.flags.continue || parsed.flags.also ? ['--continue'] : []),
    ...(parsed.flags['send-anyway'] ? ['--send-anyway'] : []),
  ]
  const { runCli } = await import('../agents/cli.js')
  const posted = await runCli(['--as', me, 'reply', convoId, ...replyFlags, '--', body])
  const effect = posted.sideEffects?.find((e) => e.event === 'message.posted' && typeof e.messageId === 'string')
  if (!posted.ok || !effect?.messageId || !effect.companyId) {
    // The reply's refusal names `cumora reply`; the retry has to be this command.
    const again = kind === 'choice' ? 'cumora ask' : 'cumora secret request'
    return { ...posted, text: `not asked. ${posted.text}\nTo ask after all, rerun ${again}; its --continue and --send-anyway work as in reply.` }
  }

  const messageId = effect.messageId
  const companyId = effect.companyId
  let card: Card
  try {
    card = (await getForkStore()).createCard({ messageId, companyId, conversationId: convoId, agentId: me, kind, question, options })
  } catch (err) {
    return fail(`your message ${messageId} was posted, but its card was not: ${err instanceof Error ? err.message : String(err)}. Ask again with a new message.`)
  }
  await announce(companyId, card)
  const text = kind === 'choice'
    ? `asked · ${messageId}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\n` +
      `The pick comes back as a person's reply quoting ${messageId}; nothing else to do until then.`
    : `asked for a secret · ${messageId}\n` +
      `When a person sends it, their reply quotes ${messageId}. Then run once: cumora secret take ${messageId} <path>\n` +
      'Pick a path outside git work trees and memory/, such as ~/.secrets/<name>. ' +
      'The secret goes into that file and nowhere else: use it from the file, never print it.'
  return { ok: true, text, exitCode: 0, sideEffects: posted.sideEffects }
}

const TAKE_REFUSALS: Record<'missing' | 'waiting' | 'taken' | 'expired', (id: string) => string> = {
  missing: (id) => `${id} is not a secret request of yours`,
  waiting: (id) => `nobody has sent the secret for ${id} yet; their reply will quote ${id}`,
  taken: (id) => `the secret for ${id} was taken already, and the server no longer has it. If the file is lost, ask again with cumora secret request`,
  expired: (id) => `nobody took the secret for ${id} within a day, so it was dropped. Ask again with cumora secret request`,
}

/** The flag the computer's shim adds to a take it saves into a file
 *  (CUMORA_SHIM in agents/computer/daemon.ts). Any other caller (an older
 *  shim, the pod's curl shim, `cumora` run by hand) would print the empty text
 *  and lose the secret, which the server forgets as it hands it over. */
const SHIM_FILE = 'shim-file'

async function take(parsed: ParsedArgs, me: string): Promise<CliResult> {
  const [, messageId, path] = parsed.positional
  if (!messageId) return fail(SECRET_USAGE)
  // The shim keeps <path> on the computer and sends the message id and its flag.
  if (parsed.flags[SHIM_FILE] !== true || path !== undefined) {
    return fail("only the computer's cumora shim can take a secret, because it saves it into a file instead of printing it. On the computer, restart its daemon so the shim updates, then take it again")
  }
  const companyId = await agentCompany(me)
  if (!companyId) return fail(`unknown agent ${me}`)
  const store = await getForkStore()
  const asked = store.card(companyId, messageId)
  if (!asked || asked.kind !== 'secret' || asked.agentId !== me) return fail(TAKE_REFUSALS.missing(messageId))
  // A secret belongs to the room it was asked in: an agent taken out of that
  // room no longer gets it.
  if (!(await inRoom(companyId, me, asked.conversationId, 'agent'))) {
    return fail(`you are no longer in the room where you asked for ${messageId}, so its secret is not yours to take`)
  }
  // The person's reply wakes this agent, possibly before its answer settles.
  if (pending(asked)) await settle(store, companyId, asked, postOver(asked))
  const taken = store.takeSecret(companyId, messageId, me)
  if (typeof taken === 'string') return fail(TAKE_REFUSALS[taken](messageId))
  let value: Buffer
  try {
    value = openSecret(await secretKey(), messageId, taken.sealed)
  } catch {
    return fail(`the secret for ${messageId} could not be unsealed (the server's key changed), and it is gone now. Ask again with cumora secret request`)
  }
  await announce(companyId, store.card(companyId, messageId) as Card)
  return { ok: true, text: '', exitCode: 0, file: value.toString('base64') }
}

/** Every minute: drops the secrets nobody took within SECRET_TTL_MS (a take
 *  or a room load does too, but neither may come), and settles or opens again
 *  the answers whose post is over without a settle (a restart, a broken
 *  connection), which tells the rooms' clients. */
export function startCardSweeper(): void {
  const sweep = async () => {
    const store = await getForkStore()
    store.dropExpiredSecrets()
    for (const { companyId, card } of store.pendingAnswers()) {
      if (postOver(card)) await settle(store, companyId, card, true)
    }
  }
  const run = () => { sweep().catch((err: unknown) => console.error('[fork] card sweep failed:', err)) }
  setTimeout(run, 10_000).unref()
  setInterval(run, 60_000).unref()
}

/* ── People's answers (/api/fork/cards) ────────────────────────────────── */

class CardError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** The company of an agent that has not left, or null. */
export async function agentCompany(agentId: string): Promise<string | null> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ company_id: string }>(
    "SELECT company_id FROM participants WHERE id = $1 AND kind = 'agent' AND departed_at IS NULL",
    [agentId],
  )
  return rows[0]?.company_id ?? null
}

/** Whether a participant of that kind is in the room now. */
export async function inRoom(companyId: string, participantId: string, conversationId: string, kind: 'human' | 'agent'): Promise<boolean> {
  const { pool } = await import('../db/pool.js')
  const { rowCount } = await pool.query(
    `SELECT 1 FROM conversation_members m
       JOIN participants p ON p.id = m.participant_id AND p.company_id = m.company_id
      WHERE m.conversation_id = $1 AND m.company_id = $2 AND m.participant_id = $3
        AND p.kind = $4 AND p.departed_at IS NULL`,
    [conversationId, companyId, participantId, kind],
  )
  return Boolean(rowCount)
}

/** A card is its room's business: only the room's people see or answer it. */
async function requireMember(companyId: string, userId: string, conversationId: string): Promise<void> {
  if (!(await inRoom(companyId, userId, conversationId, 'human'))) throw new CardError(404, 'not found')
}

/** Clients learn of a card's change from `fork.card`, sent straight over Redis
 *  like `fork.agent.tool` (./agentTool.ts). With its conversation id, the
 *  WebSocket layer gives it only to the room's people (server/src/ws.ts). A
 *  lost event changes nothing else, so it is only logged: the answering client
 *  gets the card in its response, and clients load cards again on reconnect. */
async function announce(companyId: string, card: Card): Promise<void> {
  try {
    const { redis, CH_STATUS } = await import('../redis.js')
    await redis.publish(CH_STATUS, JSON.stringify({ type: 'fork.card', companyId, conversationId: card.conversationId, card }))
  } catch (err) {
    console.error(`[fork] card ${card.messageId} changed, but fork.card was not published:`, err)
  }
}

/** An answer claims its card before its reply is posted (see answerWith).
 *  This maps the client id of each post this process started to the time
 *  until which that post may still write the reply: forever while it runs,
 *  and UNSURE_MS after a broken connection, since the API may go on writing
 *  without us; statement_timeout and idle_in_transaction_session_timeout
 *  (db/pool.ts, 60 s and 30 s) end such a write well within it. A pending
 *  answer missing here was claimed before a restart, and its post died with
 *  the old process. */
const posting = new Map<string, number>()
const UNSURE_MS = 5 * 60_000
const pending = (card: Card) => card.answer !== null && card.answer.messageId === null
/** Whether a pending answer's reply can no longer be written. */
const postOver = (card: Card) => (posting.get(card.answer?.clientId ?? '') ?? 0) < Date.now()

/** Settles a pending answer on its reply when the API wrote it, which it may
 *  have done even when the post looked failed (a lost response). Without the
 *  reply, `release` opens the card again: pass it only when the post is over. */
async function settle(store: ForkStore, companyId: string, card: Card, release: boolean): Promise<Card> {
  const answer = card.answer
  if (!answer || answer.messageId) return card
  const { pool } = await import('../db/pool.js')
  // The API keeps one message per room, author and client id (api/router.ts).
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_id = $3',
    [card.conversationId, answer.by, answer.clientId],
  )
  if (rows[0]) store.settleAnswer(companyId, card.messageId, answer.clientId, rows[0].id)
  else if (release) store.releaseAnswer(companyId, card.messageId, answer.clientId)
  else return card
  posting.delete(answer.clientId)
  const now = store.card(companyId, card.messageId) as Card
  await announce(companyId, now)
  return now
}

/** Posts the answer as the person's own message through the API's message
 *  route with their credentials, so it is written exactly like one they typed. */
async function postAsCaller(req: Request, companyId: string, conversationId: string, message: { body: string; quotedMessageId: string; clientId: string }): Promise<string> {
  const { env } = await import('../env.js')
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-company-id': companyId }
  for (const name of ['authorization', 'x-session-token']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const res = await fetch(`http://127.0.0.1:${env.PORT}/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST', headers, body: JSON.stringify(message),
  })
  const data = await res.json().catch(() => ({})) as { id?: unknown; error?: unknown }
  if (!res.ok || typeof data.id !== 'string') {
    throw new CardError(502, `the answer was not posted: ${typeof data.error === 'string' ? data.error : `HTTP ${res.status}`}`)
  }
  return data.id
}

/** Closes the card under the client id its answer will carry, before the
 *  answer is posted: no second answer slips in, and clients hide the reply
 *  from its first frame because they hear of the card first. An answer whose
 *  reply was not written opens the card again. Null when someone answered first. */
async function answerWith(req: Request, store: ForkStore, companyId: string, card: Card, userId: string, body: string, option: number | null, sealed: string | null): Promise<Card | null> {
  const clientId = `card-${randomUUID()}`
  if (!store.claimAnswer(companyId, card.messageId, { by: userId, at: new Date().toISOString(), option, clientId }, sealed)) return null
  posting.set(clientId, Number.POSITIVE_INFINITY)
  const claimed = store.card(companyId, card.messageId) as Card
  await announce(companyId, claimed)
  try {
    const answerId = await postAsCaller(req, companyId, card.conversationId, { body, quotedMessageId: card.messageId, clientId })
    store.settleAnswer(companyId, card.messageId, clientId, answerId)
    posting.delete(clientId)
  } catch (err) {
    // An answer from the API means it is done with the post, so the reply
    // exists now or never will. A broken connection leaves the card closed
    // until the sweep finds the reply or UNSURE_MS is over.
    if (err instanceof CardError) posting.delete(clientId)
    else posting.set(clientId, Date.now() + UNSURE_MS)
    const now = await settle(store, companyId, claimed, postOver(claimed)).catch((lookup: unknown) => {
      console.error(`[fork] card ${card.messageId}: cannot tell whether its answer was posted; the sweep settles it`, lookup)
      return null
    })
    if (now?.answer?.messageId) return now
    if (err instanceof CardError) throw err
    throw new CardError(502, `the answer may not have been posted: ${err instanceof Error ? err.message : String(err)}`)
  }
  const settled = store.card(companyId, card.messageId) as Card
  await announce(companyId, settled)
  return settled
}

async function handle(res: Response, run: () => Promise<void>): Promise<void> {
  try { await run() } catch (err) {
    if (!(err instanceof CardError)) throw err
    res.status(err.status).json({ error: err.message })
  }
}

/** GET /api/fork/cards?conversation=<id>: the room's cards, oldest first. */
export function listCards(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  return handle(res, async () => {
    const { userId, companyId } = await requireCompany(req)
    const conversationId = String(req.query.conversation ?? '')
    if (!conversationId || conversationId.length > 100) throw new CardError(400, 'conversation is required')
    await requireMember(companyId, userId, conversationId)
    const store = await getForkStore()
    let cards = store.cards(companyId, conversationId)
    // An answer left pending by a restart settles here, so its card does not
    // stay closed without a reply.
    const stuck = cards.filter((c) => pending(c) && postOver(c))
    if (stuck.length > 0) {
      for (const c of stuck) await settle(store, companyId, c, true)
      cards = store.cards(companyId, conversationId)
    }
    res.json({ cards })
  })
}

/** The card behind POST /api/fork/cards/:messageId/…, if the caller may answer it. */
async function answerable(requireCompany: Requirer, req: Request & AuthedRequest, kind: Card['kind']) {
  const { userId, companyId } = await requireCompany(req)
  const store = await getForkStore()
  let card = store.card(companyId, String(req.params.messageId))
  if (!card || card.kind !== kind) throw new CardError(404, 'not found')
  await requireMember(companyId, userId, card.conversationId)
  if (pending(card) && postOver(card)) card = await settle(store, companyId, card, true)
  return { userId, companyId, store, card }
}

/** POST /api/fork/cards/:messageId/answer { option }: picks an option by index. */
export function answerChoice(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  return handle(res, async () => {
    const { userId, companyId, store, card } = await answerable(requireCompany, req, 'choice')
    const option: unknown = req.body?.option
    if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= card.options.length) {
      throw new CardError(400, 'option must be the index of one of the options')
    }
    const answered = await answerWith(req, store, companyId, card, userId, card.options[option], option, null)
    if (!answered) throw new CardError(409, 'someone answered first')
    res.json({ card: answered })
  })
}

/** POST /api/fork/cards/:messageId/secret { value }: sends the secret. Only its
 *  sealed form is kept, and the message says it was sent, never what it is. */
export function sendSecret(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  return handle(res, async () => {
    const { userId, companyId, store, card } = await answerable(requireCompany, req, 'secret')
    const raw = typeof req.body?.value === 'string' ? req.body.value.trim() : ''
    if (!raw) throw new CardError(400, 'value is required')
    // Keys and certificates span lines, and their files end with a newline
    // (ssh refuses a private key without one). A one-line token loses the
    // stray spaces and newline a paste brings.
    const value = raw.includes('\n') ? `${raw}\n` : raw
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new CardError(400, `the secret must be at most ${MAX_SECRET_BYTES} bytes`)
    // Only the agent that asked takes it, and only from the room it asked in.
    if (!(await inRoom(companyId, card.agentId, card.conversationId, 'agent'))) {
      throw new CardError(410, 'the agent that asked has left this room')
    }
    const sealed = sealSecret(await secretKey(), card.messageId, value)
    const body = `🔑 Sent securely. Take it once with \`cumora secret take ${card.messageId} <path>\``
    const answered = await answerWith(req, store, companyId, card, userId, body, null, sealed)
    if (!answered) throw new CardError(409, 'someone sent it first')
    res.json({ card: answered })
  })
}
