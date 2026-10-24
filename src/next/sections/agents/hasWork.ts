import type { Computer, Participant } from '@/types'

/**
 * A browser and T3 Code threads exist only for an active agent on a computer
 * of its own. A Cumora Cloud agent has neither, even in a paid workspace where
 * its `computerId` names the workspace's cloud host (`cloud-<company>`), so
 * the host's kind decides, and an unknown host shows nothing. No React here,
 * so tests call it directly; `useSeesWork` in shared.tsx adds the role.
 */
export const hasWork = (p: Participant, host: Computer | undefined): boolean =>
  p.kind === 'agent' && !p.departedAt && !!p.computerId && host !== undefined && host.kind !== 'cloud'
