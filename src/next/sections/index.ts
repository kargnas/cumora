/** Section registry: one lazy chunk per section, so a section's code loads
 *  only when someone opens it. */
import { lazy, type ComponentType } from 'react'
import type { Section } from '../router'
import type { SectionProps } from './types'

export const SECTIONS: Partial<Record<Section, ComponentType<SectionProps>>> = {
  whispers: lazy(() => import('./whispers')),
  agents: lazy(() => import('./agents')),
  boards: lazy(() => import('./boards')),
  calendar: lazy(() => import('./calendar')),
  docs: lazy(() => import('./docs')),
  shipping: lazy(() => import('./shipping')),
  library: lazy(() => import('./library')),
  observability: lazy(() => import('./observability')),
  convene: lazy(() => import('./convene')),
  me: lazy(() => import('./me')),
}
