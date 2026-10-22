/**
 * The You overview: who is signed in, the active workspace, and the list of
 * setting groups. On wide windows it is the left column and the selection
 * slides between rows; on narrow ones it is the base screen groups push over.
 */
import { memo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { useDevtools } from '@/stores/devtools'
import { useLocaleStore } from '@/lib/i18n'
import { useAppearanceStore } from '@/lib/theme'
import { switchToClassic } from '../../designPref'
import { useNT } from '../../i18n'
import { goBack, href, linkClick } from '../../router'
import { Avatar } from '../../ui/Avatar'
import { IconButton, T_FAST, useCoarse } from '../../ui/primitives'
import { IChevronLeft, IChevronRight } from '../../ui/icons'
import { CLUSTERS, GROUP_ICON, ISwap, localeLabel, roleKey, useAutoLocale, useMePerson, type GroupKey } from './parts'

function Identity() {
  const nt = useNT()
  const me = useMePerson()
  const email = useAuth((s) => s.user?.email ?? '')
  const company = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId))
  if (!me) return null
  return (
    <div className="nx-me-who">
      <Avatar p={me} size={40} />
      <span className="nx-me-who__text">
        <b>{me.name}</b>
        <span>{email}</span>
        {company && <span>{company.name} · {nt(roleKey(company.role))}</span>}
      </span>
    </div>
  )
}

/** The current value of a group, shown at the end of its row. */
function useValues(): Partial<Record<GroupKey, ReactNode>> {
  const nt = useNT()
  const appearance = useAppearanceStore((s) => s.appearance)
  const locale = useLocaleStore((s) => s.locale)
  const auto = useAutoLocale()
  const online = useComputers((s) => Object.values(s.byId).filter((c) => c.status !== 'offline').length)
  const computersLoaded = useComputers((s) => s.loaded)
  const company = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.name)
  const dev = useDevtools((s) => s.enabled)
  return {
    appearance: nt(`me.appearance.${appearance}`),
    language: auto ? nt('me.language.auto') : localeLabel(locale),
    computers: computersLoaded ? nt('me.computers.online', { n: online }) : null,
    workspace: company,
    developer: nt(dev ? 'me.on' : 'me.off'),
  }
}

const GroupLink = memo(function GroupLink({ k, active, stack, value, attention }: {
  k: GroupKey
  active: boolean
  stack: boolean
  value: ReactNode
  attention: boolean
}) {
  const nt = useNT()
  return (
    <a
      href={href({ section: 'me', id: k })}
      // Wide windows treat groups like tabs (no history per click); narrow
      // ones push the group as a screen, so Back returns to this list.
      onClick={(e) => linkClick(e, { replace: !stack })}
      className="nx-me-item"
      aria-current={active ? 'page' : undefined}
    >
      {active && !stack && <motion.span layoutId="nx-me-sel" className="nx-me-item__sel" transition={T_FAST} />}
      {GROUP_ICON[k]}
      <span className="nx-me-item__label">{nt(`me.group.${k}`)}</span>
      {attention && <span className="nx-me-item__dot" role="img" aria-label={nt('me.computers.needsUpdate')} />}
      {value && <span className="nx-me-item__value">{value}</span>}
      {stack && <IChevronRight className="nx-me-item__chev" />}
    </a>
  )
})

export function Overview({ active, stack }: { active: GroupKey | null; stack: boolean }) {
  const nt = useNT()
  const coarse = useCoarse()
  const canDev = useDevtools((s) => s.canEnable)
  const outdated = useComputers((s) => Object.values(s.byId).some((c) => c.daemonOutdated))
  const values = useValues()
  return (
    <nav className="nx-me-overview" aria-label={nt('nav.me')}>
      <header className="nx-me-head">
        {/* The phone shell shows no tab bar here, so this is the way out. */}
        {stack && coarse && (
          <IconButton label={nt('chat.back')} onClick={() => goBack(href({ section: 'chats' }))}><IChevronLeft /></IconButton>
        )}
        <h1>{nt('nav.me')}</h1>
      </header>
      <div className="nx-me-overview__scroll nx-scroll">
        <Identity />
        {CLUSTERS.map((keys, i) => (
          <ul key={keys[0]} className="nx-me-nav">
            {keys.filter((k) => k !== 'developer' || canDev).map((k) => (
              <li key={k}>
                <GroupLink k={k} active={active === k} stack={stack} value={values[k]} attention={k === 'computers' && outdated} />
              </li>
            ))}
            {i === CLUSTERS.length - 1 && (
              <li>
                <button
                  type="button"
                  className="nx-me-item"
                  onClick={switchToClassic}
                >
                  <ISwap />
                  <span className="nx-me-item__label">{nt('nav.classic')}</span>
                </button>
              </li>
            )}
          </ul>
        ))}
      </div>
    </nav>
  )
}
