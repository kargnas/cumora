/**
 * What an agent is doing with a tool call, for its bloub avatar
 * (src/next/bloub/tools.ts draws each kind). The BYOA daemon classifies its
 * engine's tool calls and the server passes the kind on to the clients.
 * Pure: the daemon bundle imports it.
 */
export const TOOL_KINDS = ['read', 'write', 'terminal', 'search', 'web'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

// Claude Code's tool names. A tool missing here (MCP, Skill, Task...) has no
// kind, and the avatar plays the generic work animation.
const BY_NAME: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  LS: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Bash: 'terminal',
  BashOutput: 'terminal',
}

// Agents read and write the workspace through the cumora CLI in Bash, so
// those commands count as what they do there, not as terminal work.
const CLI: Record<string, ToolKind> = {
  reply: 'write',
  send: 'write',
  dm: 'write',
  email: 'write',
  glance: 'read',
  messages: 'read',
  inbox: 'read',
  thread: 'read',
  search: 'search',
}

export function toolKindOf(name: string, command?: string): ToolKind | null {
  if (name === 'Bash' && command) {
    const verb = /^\s*cumora\s+([a-z-]+)/.exec(command)?.[1]
    if (verb && CLI[verb]) return CLI[verb]
  }
  return BY_NAME[name] ?? null
}

export const isToolKind = (value: unknown): value is ToolKind =>
  typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value)
