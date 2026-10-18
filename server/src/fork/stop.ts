import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** POST /api/fork/rooms/:conversationId/agents/:agentId/stop. Any person in the
 *  room can stop an agent of the room. The agent's daemon stops the running
 *  turn, marks what it had not read as read and posts who stopped it. */
export async function stopAgent(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  const room = String(req.params.conversationId)
  const agentId = String(req.params.agentId)
  if (room.length > 100 || agentId.length > 100) { res.status(400).json({ error: 'ids must be at most 100 characters' }); return }
  // Imported here for the same reason as in activity.ts: db/pool.js and the
  // Redis client load env.ts, which exits without OPENAI_API_KEY.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ byName: string }>(
    `SELECT me.name AS "byName"
       FROM conversation_members mine
       JOIN participants me ON me.id = mine.participant_id AND me.company_id = mine.company_id
       JOIN conversation_members theirs ON theirs.conversation_id = mine.conversation_id AND theirs.company_id = mine.company_id
       JOIN participants agent ON agent.id = theirs.participant_id AND agent.company_id = theirs.company_id
      WHERE mine.conversation_id = $1 AND mine.company_id = $2 AND mine.participant_id = $3
        AND me.kind = 'human'
        AND theirs.participant_id = $4 AND agent.kind = 'agent' AND agent.departed_at IS NULL`,
    [room, companyId, userId, agentId],
  )
  // Same 404 as a room that does not exist, for a room the caller is not in
  // or an agent that is not in it.
  if (!rows[0]) { res.status(404).json({ error: 'not found' }); return }
  const { deliverInterrupt } = await import('../agents/runtime/wake-bus.js')
  await deliverInterrupt(agentId, { conversationId: room, byId: userId, byName: rows[0].byName })
  res.status(202).json({ ok: true })
}
