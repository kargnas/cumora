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
 * reactions, votes) stays, and so do the usage ledgers. Their author becomes
 * a new `deleted:<hex>` id, which the client shows as a deleted agent.
 *
 * Agent ids are slugs of the name (agents/create.ts), so the next agent hired
 * under the same name would get the same id and inherit whatever still names
 * it. The id is therefore never given out again: the fork store keeps it in
 * purged_agents, which agents/create.ts skips.
 */
import { randomBytes } from 'node:crypto'
import { getForkStore } from './store.js'

/** No agent id has a colon: ids are lowercase slugs. */
export const DELETED_AUTHOR_PREFIX = 'deleted:'

/** Rows only the agent had. Swept by agent id alone, like workspace deletion
 *  in api/router.ts: agent ids are unique across workspaces. */
const OWNED_TABLES = [
  'agent_workspace', 'agent_memory', 'agent_log', 'agent_tasks',
  'agent_events', 'agent_runs', 'agent_autonomy', 'tool_calls',
] as const

/** Ids stored by value beside db/migrate.ts's AGENT_ID_CASCADE_TABLES, in the
 *  parts of rooms that stay and the usage ledgers. `$1` new id, `$2` agent id,
 *  `$3` company.
 *  ponytail: other columns (delivery recipients, document mentions, Shipping
 *  owners, JSONB id lists, `@id` in text) keep the old id, which belongs to no
 *  one now and never will; the client shows such an id as unknown. Add one here
 *  when a screen needs the "Deleted agent" name for it. */
const KEPT_COLUMNS = [
  { table: 'message_reactions', column: 'user_id', scopeSql: 'message_id IN (SELECT id FROM messages WHERE company_id = $3)' },
  { table: 'poll_votes', column: 'voter_participant_id', scopeSql: 'company_id = $3' },
  { table: 'llm_calls', column: 'agent_id', scopeSql: 'company_id = $3' },
  { table: 'llm_calls_rollup', column: 'agent_id', scopeSql: 'company_id = $3' },
  { table: 'agent_triages', column: 'agent_id', scopeSql: 'company_id = $3' },
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
    // refused) or waits and finds no agent. computer_id is left null for a
    // cloud or revoked computer: no daemon there would ever clear its queue row.
    const { rows: [agent] } = await client.query<{ departed: boolean; computer_id: string | null; avatar_url: string | null }>(
      `SELECT p.departed_at IS NOT NULL AS departed, k.id AS computer_id, p.avatar_url
         FROM participants p
         LEFT JOIN computers k ON k.id = p.computer_id AND k.kind <> 'cloud' AND k.revoked_at IS NULL
        WHERE p.id = $1 AND p.company_id = $2 AND p.kind = 'agent'
          FOR UPDATE OF p`,
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
    for (const { attachment } of files) storageKeys.push(...attachmentKeys(attachment, messageAttachmentStorageKey))
    // A file of a 1:1 room shared into a room that stays keeps it: an agent's
    // `cumora send --attach <url>` stores no key, and the cleanup worker only
    // sees references by key.
    if (storageKeys.length > 0) {
      const { rows: kept } = await client.query<{ attachment: unknown }>(
        `SELECT attachment FROM messages
          WHERE company_id = $1 AND attachment IS NOT NULL AND NOT (conversation_id = ANY($2::text[]))`,
        [companyId, rooms],
      )
      const used = new Set(kept.flatMap(({ attachment }) => attachmentKeys(attachment, messageAttachmentStorageKey)))
      storageKeys.splice(0, storageKeys.length, ...storageKeys.filter((key) => !used.has(key)))
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
    // Before COMMIT, so a failing fork store leaves nothing deleted and the
    // request can be retried; after COMMIT a retry would find no agent. The
    // computer is handed the queue only for agents that are gone from
    // participants (router.ts), so a COMMIT that fails here deletes no files.
    ;(await getForkStore()).purgeAgent(companyId, agentId, rooms, computerId)
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
  return 'purged'
}

/** The storage keys of a message's attachment, a single file or a list. */
function attachmentKeys(attachment: unknown, keyOf: (a: { key?: unknown; url?: unknown }) => string | null): string[] {
  return (Array.isArray(attachment) ? attachment : [attachment])
    .filter((a): a is { key?: unknown; url?: unknown } => !!a && typeof a === 'object')
    .map(keyOf)
    .filter((key): key is string => !!key)
}

/** The queued agents of a computer that are really gone. A queue row whose
 *  agent is still in participants comes from a purge whose COMMIT failed. */
export async function computerPurges(computerId: string): Promise<string[]> {
  const queued = (await getForkStore()).computerPurges(computerId)
  if (queued.length === 0) return []
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM participants WHERE id = ANY($1::text[])`, [queued])
  const alive = new Set(rows.map((r) => r.id))
  return queued.filter((id) => !alive.has(id))
}
