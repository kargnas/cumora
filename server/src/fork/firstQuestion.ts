/**
 * The first question: a new agent starts its direct message room with the
 * person who hired it before they write anything, asking with a question card
 * (`cumora ask`, ./cards.ts) what they want it to do.
 *
 * `POST /api/agents` (api/router.ts) makes that room, then calls
 * askFirstQuestion, which wakes the agent there with the system message a
 * Calendar dispatch posts, through upstream's own `postDispatchMessage`
 * (../calendar.ts), in the `calendar_event` envelope with `eventKind:
 * 'hired'`, as a trigger fires (./triggers.ts): the daemon's and the triage's
 * alarm gates wake the assignee, and the clients keep it out of the
 * transcript. A retried create that finds the agent it already made posts
 * nothing.
 *
 * The daemon shows an agent only the envelope's title and agentPrompt, and its
 * wake digest cuts that line at 600 characters, so the brief is short: the
 * agent's CLAUDE.md or AGENTS.md already carries its name, role and style, and
 * the wake brings its own memory index and the shared one (./sharedMemory.ts),
 * where what other agents learned about the person is.
 */

export interface Person {
  id: string
  name: string
}

function brief(owner: Person, room: string): string {
  return (
    `${owner.name} (@${owner.id}) just hired you. Before they write, start your direct message room with ` +
    `them: run \`cumora ask ${room} "<question>" "<option>" ... --body "<greeting>"\` once. The greeting ` +
    `speaks their language, addresses them the way they like (your shared memory may say both) and ` +
    `says in one sentence who you are. The question asks what they want you to do, with three or four short ` +
    `options that fit your name, role and style. Post nothing else, and keep their answer in memory/.`
  )
}

export function firstQuestionEnvelope(agent: Person, owner: Person, room: string, at = new Date()): string {
  // No eventId: the classic UI would link the row to a Calendar event that
  // does not exist.
  return JSON.stringify({
    kind: 'calendar_event',
    eventKind: 'hired',
    title: `${owner.name} hired ${agent.name}`,
    agentPrompt: brief(owner, room),
    assigneeId: agent.id,
    targetConversationId: room,
    scheduledFor: at.toISOString(),
    createdBy: owner.id,
  })
}

export async function askFirstQuestion(args: { companyId: string; conversationId: string; agentId: string; ownerId: string }): Promise<void> {
  // Imported here, not at the top: db/pool.js and calendar.js load env.ts,
  // which the unit tests of this file run without.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<Person>(
    `SELECT id, name FROM participants WHERE company_id = $1 AND id = ANY($2::text[])`,
    [args.companyId, [args.agentId, args.ownerId]],
  )
  const agent = rows.find((r) => r.id === args.agentId)
  const owner = rows.find((r) => r.id === args.ownerId)
  if (!agent || !owner) throw new Error(`no participant row for ${agent ? args.ownerId : args.agentId}`)
  const { postDispatchMessage } = await import('../calendar.js')
  await postDispatchMessage({
    event: { company_id: args.companyId, assignee_id: agent.id },
    conversationId: args.conversationId,
    body: firstQuestionEnvelope(agent, owner, args.conversationId),
  })
}
