/** Workspace owners and admins: who may change an agent for everyone, and who
 *  may read agent text and developer figures, which can quote any room
 *  (src/next/AGENTS.md). The same set as upstream's DEVTOOLS_ROLES in
 *  api/router.ts, kept here so fork routes do not import upstream's router. */
export function isPrivileged(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}
