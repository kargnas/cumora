/** Workspace owners and admins: who may change an agent for everyone, and who
 *  may read agent text and developer figures, which can quote any room
 *  (src/next/AGENTS.md). */
export function isPrivileged(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}
