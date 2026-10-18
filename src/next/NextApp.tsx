/**
 * Shell of the Next redesign (`/next`). App.tsx mounts this instead of the
 * classic Desktop/Mobile shells; all data, auth and WebSocket boot still
 * happen in App.tsx, so this file only owns layout, routing and chrome.
 */
import { Suspense, useEffect, useMemo } from 'react'
import { useAuth } from '@/stores/auth'
import { useDevtools } from '@/stores/devtools'
import { isMuted, useConversations } from '@/stores/conversations'
import { EmailComposer } from '@/components/EmailComposer'
import { isElectron } from '@/lib/runtime'
import { useAppearanceStore, type Appearance } from '@/lib/theme'
import { initPushNotifications } from '@/lib/push'
import { bindPressHaptics } from './haptics'
import { useNativeChrome, useNextDocument } from './document'
import { bindLegacyWrites, goBack, href, linkClick, navigate, projectRoute, useRoute, type Route, type Section } from './router'
import { useLayout, type Layout } from './layout'
import { useNT, type NKey } from './i18n'
import { TooltipLayer, useCoarse, useTooltip, Spinner, Menu, useMenu } from './ui/primitives'
import {
  IAgents, IBoard, ICalendar, IChat, IDoc, ILibrary, IObserve, IShip, IWhisper, IGrid,
  ICheck, IMonitor, IMoon, ISun,
} from './ui/icons'
import { ChatsSection } from './chat/ChatsSection'
import { Palette } from './chat/Palette'
import { SECTIONS } from './sections'
import './styles/shell.css'
import './styles/chat.css'
import './styles/panel.css'

interface NavItem { section: Section; label: NKey; icon: JSX.Element }

const NAV: NavItem[] = [
  { section: 'chats', label: 'nav.chats', icon: <IChat /> },
  { section: 'agents', label: 'nav.agents', icon: <IAgents /> },
  { section: 'whispers', label: 'nav.whispers', icon: <IWhisper /> },
  { section: 'boards', label: 'nav.boards', icon: <IBoard /> },
  { section: 'calendar', label: 'nav.calendar', icon: <ICalendar /> },
  { section: 'docs', label: 'nav.docs', icon: <IDoc /> },
  { section: 'shipping', label: 'nav.shipping', icon: <IShip /> },
  { section: 'library', label: 'nav.library', icon: <ILibrary /> },
  { section: 'observability', label: 'nav.observability', icon: <IObserve /> },
]

function useNav(): NavItem[] {
  const devtools = useDevtools((s) => s.enabled)
  return useMemo(() => NAV.filter((n) => n.section !== 'observability' || devtools), [devtools])
}

function useUnreadTotal(): number {
  return useConversations((s) => s.list.reduce((n, c) => n + (isMuted(c) ? 0 : (c.unread ?? 0)), 0))
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const nt = useNT()
  const tip = useTooltip(nt(item.label))
  const unread = useUnreadTotal()
  return (
    <a
      href={href({ section: item.section })}
      onClick={linkClick}
      className="nx-rail__item"
      data-haptic
      aria-current={active ? 'page' : undefined}
      aria-label={nt(item.label)}
      {...tip}
    >
      {item.icon}
      {item.section === 'chats' && unread > 0 && <span className="nx-rail__dot" aria-hidden />}
    </a>
  )
}

function WorkspaceButton() {
  const nt = useNT()
  const companies = useAuth((s) => s.companies)
  const activeId = useAuth((s) => s.activeCompanyId)
  const setActive = useAuth((s) => s.setActiveCompany)
  const active = companies.find((c) => c.id === activeId)
  const menu = useMenu()
  const tip = useTooltip(active?.name ?? nt('nav.workspace'), 'below')
  return (
    <>
      <button
        type="button"
        className="nx-rail__ws"
        aria-label={nt('nav.workspace')}
        onClick={(e) => menu.toggleFrom(e.currentTarget)}
        {...tip}
      >
        {(active?.name ?? 'C').slice(0, 1).toUpperCase()}
      </button>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { label: nt('nav.workspaces') },
          ...companies.map((c) => ({
            key: c.id,
            label: c.name,
            onSelect: () => { if (c.id !== activeId) setActive(c.id) },
          })),
          'sep',
          { key: 'classic', label: nt('nav.classic'), onSelect: () => { localStorage.setItem('cumora.ui', 'classic'); location.href = '/' } },
        ]}
      />
    </>
  )
}

/** System / Light / Dark, one tap from anywhere on desktop. */
function AppearanceButton() {
  const nt = useNT()
  const appearance = useAppearanceStore((s) => s.appearance)
  const setAppearance = useAppearanceStore((s) => s.setAppearance)
  const menu = useMenu()
  const tip = useTooltip(nt('nav.appearance'))
  const icon = appearance === 'dark' ? <IMoon /> : appearance === 'light' ? <ISun /> : <IMonitor />
  const option = (key: Appearance, label: string, glyph: JSX.Element) => ({
    key,
    label,
    icon: appearance === key ? <ICheck /> : glyph,
    onSelect: () => setAppearance(key),
  })
  return (
    <>
      <button type="button" className="nx-rail__item" aria-label={nt('nav.appearance')} onClick={(e) => menu.toggleFrom(e.currentTarget)} {...tip}>
        {icon}
      </button>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { label: nt('nav.appearance') },
          option('system', nt('nav.appearanceSystem'), <IMonitor />),
          option('light', nt('nav.appearanceLight'), <ISun />),
          option('dark', nt('nav.appearanceDark'), <IMoon />),
        ]}
      />
    </>
  )
}

function MeLink({ active }: { active: boolean }) {
  const nt = useNT()
  const name = useAuth((s) => s.user?.name ?? '')
  const tip = useTooltip(nt('nav.me'))
  return (
    <a
      href={href({ section: 'me' })}
      onClick={linkClick}
      className="nx-rail__me"
      data-haptic
      aria-current={active ? 'page' : undefined}
      aria-label={nt('nav.me')}
      {...tip}
    >
      {name.slice(0, 1).toUpperCase() || '·'}
    </a>
  )
}

function Rail({ route }: { route: Route }) {
  const nt = useNT()
  const nav = useNav()
  return (
    <nav className="nx-rail" aria-label={nt('nav.sections')}>
      <WorkspaceButton />
      <div className="nx-rail__items">
        {nav.map((item) => <RailLink key={item.section} item={item} active={route.section === item.section} />)}
      </div>
      <AppearanceButton />
      <MeLink active={route.section === 'me'} />
    </nav>
  )
}

/** Phone chrome: four destinations plus a sheet with the rest. */
function TabBar({ route }: { route: Route }) {
  const nt = useNT()
  const nav = useNav()
  const unread = useUnreadTotal()
  const meName = useAuth((s) => s.user?.name ?? '')
  const menu = useMenu()
  const primary: Section[] = ['chats', 'agents', 'boards', 'me']
  const more = nav.filter((n) => !primary.includes(n.section))
  const tab = (section: Section, label: NKey, icon: JSX.Element) => (
    <a
      key={section}
      href={href({ section })}
      onClick={(e) => linkClick(e, { replace: true })}
      className="nx-tabbar__item"
      aria-current={route.section === section ? 'page' : undefined}
      data-haptic
    >
      <span className="nx-tabbar__icon">
        {icon}
        {section === 'chats' && unread > 0 && <span className="nx-badge nx-tabbar__badge">{unread > 99 ? '99+' : unread}</span>}
      </span>
      <span>{nt(label)}</span>
    </a>
  )
  const moreActive = more.some((n) => n.section === route.section)
  return (
    <nav className="nx-tabbar" aria-label={nt('nav.sections')}>
      {tab('chats', 'nav.chats', <IChat />)}
      {tab('agents', 'nav.agents', <IAgents />)}
      {tab('boards', 'nav.boards', <IBoard />)}
      <button
        type="button"
        className="nx-tabbar__item"
        aria-current={moreActive ? 'page' : undefined}
        data-haptic
        onClick={(e) => menu.toggleFrom(e.currentTarget)}
      >
        <span className="nx-tabbar__icon"><IGrid /></span>
        <span>{nt('nav.more')}</span>
      </button>
      {tab('me', 'nav.me', <span className="nx-tabbar__me">{meName.slice(0, 1).toUpperCase()}</span>)}
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={more.map((n) => ({
          key: n.section,
          label: nt(n.label),
          icon: n.icon,
          onSelect: () => navigate(href({ section: n.section }), { replace: true }),
        }))}
      />
    </nav>
  )
}

/** Android hardware back: close what is on top, then walk the in-app history. */
function useHardwareBack(route: Route, layout: Layout): void {
  useEffect(() => {
    const onBack = (e: Event) => {
      // A section that closes its own sheet or pushed screen claims the key first.
      if (e.defaultPrevented) return
      if (route.section === 'chats' && route.id && layout === 'stack') {
        e.preventDefault()
        goBack(href({ section: 'chats' }))
        return
      }
      if (route.threadId || route.peek || (route.panel && route.panel !== 'none' && layout !== 'full')) {
        e.preventDefault()
        history.back()
        return
      }
      if (route.section !== 'chats') {
        e.preventDefault()
        navigate(href({ section: 'chats' }), { replace: true })
      }
    }
    window.addEventListener('cumora:hardware-back', onBack)
    return () => window.removeEventListener('cumora:hardware-back', onBack)
  }, [route, layout])
}

export default function NextApp() {
  useNextDocument()
  useNativeChrome()
  const route = useRoute()
  const layout = useLayout()
  const coarse = useCoarse()
  const stack = layout === 'stack'

  useEffect(() => bindLegacyWrites(), [])
  useEffect(() => bindPressHaptics(), [])
  useEffect(() => { projectRoute(route, stack) }, [route, stack])
  useHardwareBack(route, layout)
  // The classic mobile shell owned push registration (APNs/FCM); this shell
  // replaces it in the native app. No-op on web and Electron.
  useEffect(() => { void initPushNotifications() }, [])

  // Observability is gated server-side; leave it the moment devtools say no.
  const devtoolsLoaded = useDevtools((s) => s.loaded)
  const devtoolsEnabled = useDevtools((s) => s.enabled)
  const loadDevtools = useDevtools((s) => s.load)
  useEffect(() => { void loadDevtools() }, [loadDevtools])
  useEffect(() => {
    if (route.section === 'observability' && devtoolsLoaded && !devtoolsEnabled) navigate(href({ section: 'chats' }), { replace: true })
  }, [route.section, devtoolsLoaded, devtoolsEnabled])

  const showTabBar = stack && coarse && !(route.section === 'chats' && route.id) && route.section !== 'me'
  const showRail = !(stack && coarse)

  return (
    <TooltipLayer>
      <div className="nx-app" data-layout={layout} data-coarse={coarse || undefined} data-electron={isElectron || undefined}>
        {/* Desktop app: the window has no system title bar, so this strip is
            what you drag, and it keeps clear of the macOS traffic lights. */}
        {isElectron && <div className="nx-dragbar" aria-hidden />}
        {showRail && <Rail route={route} />}
        <main className="nx-main">
          {route.section === 'chats' ? (
            <ChatsSection route={route} layout={layout} />
          ) : (
            <SectionHost route={route} layout={layout} />
          )}
        </main>
        {showTabBar && <TabBar route={route} />}
      </div>
      <Palette />
      {/* Classic email composer reads useApp.composeEmail itself and draws
          as an overlay, so it works from any section. */}
      <EmailComposer />
      <SelectionGuard />
    </TooltipLayer>
  )
}

function SectionHost({ route, layout }: { route: Route; layout: Layout }) {
  const View = SECTIONS[route.section]
  if (!View) return null
  return (
    // Keyed by section so each screen mounts fresh and plays its entrance.
    <Suspense fallback={<div className="nx-center" aria-busy="true"><Spinner large /></div>}>
      <div key={route.section} className="nx-section">
        <View route={route} layout={layout} stack={layout === 'stack'} />
      </div>
    </Suspense>
  )
}

/** A conversation that disappears (left, deleted, workspace switch) must not
 *  leave the URL pointing at nothing. */
function SelectionGuard() {
  const route = useRoute()
  const loaded = useConversations((s) => s.loaded)
  const exists = useConversations((s) => (route.id ? s.list.some((c) => c.id === route.id) : true))
  useEffect(() => {
    if (route.section !== 'chats' || !route.id || !loaded || exists) return
    navigate(href({ section: 'chats' }), { replace: true })
  }, [route.section, route.id, loaded, exists])
  return null
}
