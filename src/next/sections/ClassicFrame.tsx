import type { ReactNode } from 'react'

/** Hosts a classic (pre-redesign) screen inside the new shell. */
export function ClassicFrame({ children }: { children: ReactNode }) {
  return <div className="nx-legacy">{children}</div>
}
