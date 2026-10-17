/**
 * You: the account, this device's preferences, the workspace and its
 * computers.
 *
 * `/next/me` is the overview (who is signed in, the active workspace, the
 * setting groups) and `/next/me/<group>` opens one group. Wide windows show
 * the list and the open group side by side; narrow ones push the group over
 * the list with swipe-back. Dialogs and disclosures live in query params
 * (see parts.tsx), so Back closes them.
 */
import { useEffect, useState, type ComponentType } from 'react'
import { AnimatePresence, motion, useTransform } from 'framer-motion'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { useDevtools } from '@/stores/devtools'
import { useNT } from '../../i18n'
import { getRoute, goBack, href, navigate, type Route } from '../../router'
import { IconButton, SPRING_SHEET, T_FAST } from '../../ui/primitives'
import { IChevronLeft } from '../../ui/icons'
import type { SectionProps } from '../types'
import { closeSheet, isGroup, ScrollParentProvider, type GroupKey } from './parts'
import { Overview } from './Overview'
import { AboutPage, AccountPage, ProfilePage } from './you'
import { AppearancePage, DeveloperPage, LanguagePage, NotificationsPage } from './device'
import { WorkspacePage } from './workspace'
import { ComputersPage } from './computers'
import { TrustPage } from './trust'
import { ProjectsPage } from './projects'
import { UsagePage } from './usage'
import './me.css'

const PAGES: Record<GroupKey, ComponentType<{ route: Route }>> = {
  profile: ProfilePage,
  account: AccountPage,
  appearance: AppearancePage,
  language: LanguagePage,
  notifications: NotificationsPage,
  workspace: WorkspacePage,
  computers: ComputersPage,
  trust: TrustPage,
  projects: ProjectsPage,
  usage: UsagePage,
  developer: DeveloperPage,
  about: AboutPage,
}

function GroupPage({ route, group, stack }: { route: Route; group: GroupKey; stack: boolean }) {
  const nt = useNT()
  // Long lists inside a page virtualize against this scroller.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const Page = PAGES[group]
  const title = nt(`me.group.${group}`)
  return (
    <section className="nx-me-page" aria-label={title}>
      <header className="nx-me-head">
        <div className="nx-me-page__col nx-me-head__col">
          {stack && (
            <IconButton label={nt('chat.back')} onClick={() => goBack(href({ section: 'me' }))}><IChevronLeft /></IconButton>
          )}
          <h1>{title}</h1>
        </div>
      </header>
      <div ref={setScroller} className="nx-me-page__scroll nx-scroll">
        {/* A pushed screen already slides in; side by side, the page fades. */}
        <motion.div
          className="nx-me-page__col nx-me-page__body"
          initial={stack ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={T_FAST}
        >
          <ScrollParentProvider value={scroller}>
            <Page route={route} />
          </ScrollParentProvider>
        </motion.div>
      </div>
    </section>
  )
}

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** Narrow: the overview is the base screen and a group slides over it; the
 *  list underneath peeks back with parallax while the group is swiped away. */
function StackMe({ route, group }: { route: Route; group: GroupKey | null }) {
  const w = useWidth()
  const swipe = useSwipeBackProps(() => goBack(href({ section: 'me' })))
  const baseX = useTransform(swipe.x, (v) => -w * 0.3 + (Math.min(v, w) / w) * w * 0.3)
  return (
    <div className="nx-stackview nx-me">
      <motion.div className="nx-stackview__base" style={{ x: group ? baseX : 0 }} {...(group ? { inert: '' } : {})}>
        <Overview active={group} stack />
      </motion.div>
      <AnimatePresence initial={false}>
        {group && (
          <motion.div
            key="group"
            className="nx-pushed"
            initial={{ x: w }}
            animate={{ x: 0 }}
            exit={{ x: w }}
            transition={SPRING_SHEET}
            {...swipe.props}
            style={{ ...swipe.props.style, zIndex: 1 }}
          >
            <GroupPage key={group} route={route} group={group} stack />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Android back inside You closes the open dialog, then the pushed group.
 *  The shell's own handler (which jumps to Chats) registers first, so this
 *  listens in the capture phase and stops the event once it handled it. */
function useHardwareBack(stack: boolean): void {
  useEffect(() => {
    const onBack = (e: Event) => {
      const r = getRoute()
      const sheet = r.search.get('sheet')
      if (r.section !== 'me') return
      if (sheet) closeSheet(sheet)
      else if (stack && r.id) goBack(href({ section: 'me' }))
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('cumora:hardware-back', onBack, { capture: true })
    return () => window.removeEventListener('cumora:hardware-back', onBack, { capture: true })
  }, [stack])
}

export default function MeSection({ route, stack }: SectionProps) {
  const canDev = useDevtools((s) => s.canEnable)
  const devLoaded = useDevtools((s) => s.loaded)
  const id = route.id
  // Developer tools exist for owners and admins only; until the capability
  // check lands, the page waits instead of bouncing the URL.
  const group = id !== null && isGroup(id) && (id !== 'developer' || canDev || !devLoaded) ? id : null

  useEffect(() => {
    if (group || (id === null && stack)) return
    // Unknown groups fall back to the list; wide windows always show a group.
    navigate(href({ section: 'me', id: stack ? null : 'profile' }), { replace: true })
  }, [group, id, stack])

  useHardwareBack(stack)

  if (stack) return <StackMe route={route} group={group} />
  return (
    <div className="nx-me nx-me--split">
      <Overview active={group} stack={false} />
      {group ? <GroupPage key={group} route={route} group={group} stack={false} /> : <div />}
    </div>
  )
}
