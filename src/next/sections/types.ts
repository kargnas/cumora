import type { Layout } from '../layout'
import type { Route } from '../router'

/** Props every section screen receives from the shell. */
export interface SectionProps {
  route: Route
  layout: Layout
  /** Narrow window: one screen at a time, pushed with swipe-back. */
  stack: boolean
}
