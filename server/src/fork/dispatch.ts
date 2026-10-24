/**
 * Waking an agent from the fork. Triggers (./triggers.ts), T3 Code threads
 * (./coding.ts) and a new agent's first question (./firstQuestion.ts) post the
 * system message a Calendar dispatch posts, through upstream's own
 * `postDispatchMessage` (../calendar.ts), in its `calendar_event` envelope.
 * The daemon's alarm gate (agents/computer/daemon.ts `parseAlarmPayload`) and
 * the triage's (agents/triage-core.ts) wake the agent named by `assigneeId` and
 * show it the title and agentPrompt, and the clients keep the message out of
 * the transcript. That contract lives here once.
 */

export interface Wake {
  companyId: string
  assigneeId: string
  conversationId: string
  eventKind: string
  title: string
  agentPrompt: string
  scheduledFor: string
  description?: string
  createdBy?: string
  triggerId?: string
}

export function wakeBody(w: Wake): string {
  // No eventId: the classic UI would link the row to a Calendar event that
  // does not exist. Fields left undefined are dropped from the JSON.
  return JSON.stringify({
    kind: 'calendar_event',
    eventKind: w.eventKind,
    triggerId: w.triggerId,
    title: w.title,
    description: w.description,
    agentPrompt: w.agentPrompt,
    assigneeId: w.assigneeId,
    targetConversationId: w.conversationId,
    scheduledFor: w.scheduledFor,
    createdBy: w.createdBy,
  })
}

/** Posts the wake into its room and returns the message id. */
export async function postWake(w: Wake): Promise<string> {
  // Imported here, not at the top: calendar.js loads db/pool.js and env.ts,
  // which the callers' unit tests run without.
  const { postDispatchMessage } = await import('../calendar.js')
  return postDispatchMessage({
    event: { company_id: w.companyId, assignee_id: w.assigneeId },
    conversationId: w.conversationId,
    body: wakeBody(w),
  })
}
