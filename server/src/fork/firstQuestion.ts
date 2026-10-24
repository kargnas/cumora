/**
 * The first question: a new agent starts its direct message room with the
 * person who hired it before they write anything, asking with a question card
 * (`cumora ask`, ./cards.ts) what they want it to do.
 *
 * `POST /api/agents` (api/router.ts) makes that room, then calls
 * askFirstQuestion, which wakes the agent there through ./dispatch.ts with
 * `eventKind: 'hired'`. It is best-effort and posted once, like the handler's
 * other follow-ups: a retried create that finds the agent it already made
 * posts nothing, and a failed post leaves the agent waiting to be spoken to.
 *
 * The brief reaches the agent whole in the triage note, and again in its wake
 * digest, where the daemon cuts the alarm line at 600 characters, so what it
 * must do comes first. The agent's CLAUDE.md or AGENTS.md carries its name,
 * role and style, and the wake brings its own memory index and the shared one
 * (./sharedMemory.ts), where what other agents learned about the person is.
 */
import { postWake, type Wake } from './dispatch.js'

export interface Person {
  id: string
  name: string
}

function brief(owner: Person, room: string): string {
  return (
    `${owner.name} (@${owner.id}) just hired you. Before they write, start your direct message room with ` +
    `them with one question card and nothing else: run \`cumora ask ${room} "<question>" "<option>" ... ` +
    `--body "<greeting>"\` once. The greeting speaks their language, addresses them the way they like (your ` +
    `shared memory may say both) and says in one sentence who you are. The question asks what they want you ` +
    `to do, with three or four short options that fit your name, role and style. Keep their answer in memory/.`
  )
}

export function firstQuestionWake(companyId: string, agent: Person, owner: Person, room: string): Wake {
  return {
    companyId,
    assigneeId: agent.id,
    conversationId: room,
    eventKind: 'hired',
    title: `${owner.name} hired ${agent.name}`,
    agentPrompt: brief(owner, room),
    scheduledFor: new Date().toISOString(),
    extra: { createdBy: owner.id },
  }
}

export async function askFirstQuestion(args: { companyId: string; conversationId: string; agent: Person; ownerId: string }): Promise<void> {
  // Imported here, not at the top: db/pool.js loads env.ts, which the unit
  // tests of this file run without.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM participants WHERE company_id = $1 AND id = $2`,
    [args.companyId, args.ownerId],
  )
  if (!rows[0]) throw new Error(`no participant row for ${args.ownerId}`)
  const owner = { id: args.ownerId, name: rows[0].name }
  await postWake(firstQuestionWake(args.companyId, args.agent, owner, args.conversationId))
}
