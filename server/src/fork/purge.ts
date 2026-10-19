/**
 * Deleting an off-boarded agent for good: DELETE /api/fork/agents/:agentId.
 *
 * Off-boarding (upstream DELETE /api/agents/:id) only marks the agent departed
 * so it can be re-hired. Deleting removes the agent, its 1:1 rooms and what it
 * owned: memory, log, workspace, tasks, runs, routines, its look, the
 * Handbook's versions of its home, and its files on its computer
 * (./computer-purge.ts, through the computer_purges queue).
 *
 * What the agent wrote in rooms that stay (messages, comments, documents,
 * reactions, votes) stays, and so does the usage ledger. Their author becomes
 * a new `deleted:<hex>` id, which the client shows as a deleted agent. Agent
 * ids are slugs of the name (agents/create.ts), so the next agent hired under
 * the same name gets the same id; without the new id it would inherit the old
 * agent's messages.
 */
import { randomBytes } from 'node:crypto'
import { getForkStore } from './store.js'

/** No agent id has a colon: ids are lowercase slugs. */
export const DELETED_AUTHOR_PREFIX = 'deleted:'

/** Rows only the agent had. Swept by agent id alone, like workspace deletion
 *  in api/router.ts: agent ids are unique across workspaces. */
const OWNED_TABLES = [
  'agent_workspace', 'agent_memory', 'agent_log', 'agent_tasks',
  'agent_events', 'agent_runs', 'agent_triages', 'agent_autonomy', 'tool_calls',
] as const

/** Ids stored by value beside db/migrate.ts's AGENT_ID_CASCADE_TABLES, in the
 *  parts of rooms that stay. `$1` new id, `$2` agent id, `$3` company.
 *  ponytail: JSONB id lists (shipping builders, convene notes, reminder
 *  recipients, routing candidates) and `@id` mentions in text keep the old id,
 *  so an agent hired later under the same name would match them. Add them here
 *  if one of those features is used. */
const KEPT_COLUMNS = [
  { table: 'message_reactions', column: 'user_id', scopeSql: 'message_id IN (SELECT id FROM messages WHERE company_id = $3)' },
  { table: 'poll_votes', column: 'voter_participant_id', scopeSql: 'company_id = $3' },
  { table: 'llm_calls', column: 'agent_id', scopeSql: 'company_id = $3' },
  { table: 'llm_calls_rollup', column: 'agent_id', scopeSql: 'company_id = $3' },
] as const

export type PurgeResult = 'purged' | 'not_found' | 'active'

export async function purgeAgent(companyId: string, agentId: string): Promise<PurgeResult> {
  // Imported here, not at the top: db/pool.js loads env.ts, which exits
  // without OPENAI_API_KEY and would kill the tests that import this module.
  const { pool } = await import('../db/pool.js')
  const { AGENT_ID_CASCADE_TABLES } = await import('../db/migrate.js')
  const { messageAttachmentStorageKey, storageKeyFromPublicUrl } = await import('../storage.js')
  const { enqueueWorkspaceCleanup, nudgeWorkspaceCleanupWorker } = await import('../workspace-cleanup.js')
  const author = DELETED_AUTHOR_PREFIX + randomBytes(4).toString('hex')

  const client = await pool.connect()
  let rooms: string[]
  let computerId: string | null
  try {
    await client.query('BEGIN')
    // Locked, so a re-hire racing this either lands first (and the delete is
    // refused) or waits and finds no agent.
    const { rows: [agent] } = await client.query<{ departed: boolean; computer_id: string | null; avatar_url: string | null }>(
      `SELECT departed_at IS NOT NULL AS departed, computer_id, avatar_url
         FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent' FOR UPDATE`,
      [agentId, companyId],
    )
    if (!agent) { await client.query('ROLLBACK'); return 'not_found' }
    if (!agent.departed) { await client.query('ROLLBACK'); return 'active' }
    computerId = agent.computer_id

    const { rows: direct } = await client.query<{ id: string }>(
      `SELECT c.id FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id AND m.company_id = c.company_id
        WHERE c.company_id = $1 AND c.kind = 'direct' AND m.participant_id = $2`,
      [companyId, agentId],
    )
    rooms = direct.map((r) => r.id)
    const storageKeys: string[] = []
    const avatarKey = agent.avatar_url ? storageKeyFromPublicUrl(agent.avatar_url) : null
    if (avatarKey) storageKeys.push(avatarKey)
    const { rows: files } = await client.query<{ attachment: unknown }>(
      `SELECT attachment FROM messages WHERE conversation_id = ANY($1::text[]) AND attachment IS NOT NULL`, [rooms],
    )
    for (const { attachment } of files) {
      for (const candidate of Array.isArray(attachment) ? attachment : [attachment]) {
        if (!candidate || typeof candidate !== 'object') continue
        const key = messageAttachmentStorageKey(candidate as { key?: unknown; url?: unknown })
        if (key) storageKeys.push(key)
      }
    }
    // Messages, members, reads and the rest of a room cascade from it.
    await client.query(`DELETE FROM conversations WHERE id = ANY($1::text[]) AND company_id = $2`, [rooms, companyId])

    // Leaves the rooms that stay, without a "left" line: it left when it was off-boarded.
    const { rows: left } = await client.query<{ conversation_id: string }>(
      `DELETE FROM conversation_members WHERE company_id = $1 AND participant_id = $2 RETURNING conversation_id`,
      [companyId, agentId],
    )
    for (const { conversation_id } of left) {
      await client.query(`SELECT refresh_conversation_members_projection($1)`, [conversation_id])
    }

    for (const table of OWNED_TABLES) await client.query(`DELETE FROM ${table} WHERE agent_id = $1`, [agentId])
    await client.query(`DELETE FROM agent_climate WHERE agent_id = $1 OR about_id = $1`, [agentId])
    for (const table of ['conversation_reads', 'conversation_mutes', 'board_mention_reads']) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [agentId])
    }
    // Its routines go with it (dispatches and reminders cascade); cards it was
    // on lose their assignee.
    await client.query(`DELETE FROM calendar_events WHERE company_id = $1 AND assignee_id = $2`, [companyId, agentId])
    await client.query(
      `UPDATE board_cards SET assignee_id = NULL
        WHERE assignee_id = $1 AND board_id IN (SELECT id FROM boards WHERE company_id = $2)`,
      [agentId, companyId],
    )

    for (const t of [...AGENT_ID_CASCADE_TABLES, ...KEPT_COLUMNS]) {
      await client.query(`UPDATE ${t.table} SET ${t.column} = $1 WHERE ${t.column} = $2 AND ${t.scopeSql}`, [author, agentId, companyId])
    }
    await client.query(`DELETE FROM participants WHERE id = $1 AND company_id = $2`, [agentId, companyId])
    // agentIds stays empty: that list deletes Kubernetes pods, which a
    // computer's agent never had.
    await enqueueWorkspaceCleanup(client, { companyId, agentIds: [], storageKeys })
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  nudgeWorkspaceCleanupWorker()
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache(agentId)
  // After the commit: a queued purge for an agent that still exists would have
  // its computer delete the home of an agent that can be re-hired.
  ;(await getForkStore()).purgeAgent(companyId, agentId, rooms, computerId)
  return 'purged'
}
