import { isToolKind } from './toolKind.js'

/**
 * Tells the workspace's clients which kind of tool a working agent is running,
 * so its bloub avatar can act it out. It is a passing hint, not state: it goes
 * straight to Redis on the status channel, which the WebSocket layer fans out
 * to the company (server/src/ws.ts), and skips upstream's Postgres outbox,
 * which fork code does not write. A client that missed it shows generic work.
 */
export async function publishAgentTool(companyId: string, agentId: string, tool: unknown): Promise<void> {
  // Imported here: redis.js loads env.ts, which exits without OPENAI_API_KEY in tests.
  const { redis, CH_STATUS } = await import('../redis.js')
  await redis.publish(CH_STATUS, JSON.stringify({
    type: 'fork.agent.tool',
    companyId,
    participantId: agentId,
    tool: isToolKind(tool) ? tool : null,
  }))
}
