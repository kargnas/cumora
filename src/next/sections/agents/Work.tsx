/**
 * An agent's workspace, the first view of its page for owners and admins: its
 * browser large, beside its T3 Code threads and the Handbook's newest changes.
 * The room panel's Computer and Coding tabs and the agent drawer show the same
 * Screen and CodingList. The two columns stack once the pane is narrow.
 */
import { useLocale } from '@/lib/i18n'
import type { Participant } from '@/types'
import { relative } from '../../format'
import { useNT } from '../../i18n'
import { linkClick, useRoute, withRoute } from '../../router'
import { Spinner } from '../../ui/primitives'
import { CodingList } from '../../panel/CodingTab'
import { Screen } from '../../panel/ComputerTab'
import { sinceTime, useHandbook } from '../../panel/handbook'

const CHANGES = 3

/** The Handbook's newest changes this week, each with the message behind it. */
function Changes({ agentId }: { agentId: string }) {
  const nt = useNT()
  const locale = useLocale()
  const route = useRoute()
  const { data, error, retry } = useHandbook(agentId, sinceTime('7d'), null)
  if (error === 'locked') return <div className="nx-empty">{nt('handbook.lockedBody')}</div>
  if (!data) {
    return error
      ? (
        <div className="nx-empty" role="alert">
          {nt('handbook.loadFailed')}
          <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={retry}>{nt('handbook.retry')}</button>
        </div>
      )
      : <div className="nx-center" aria-busy="true"><Spinner /></div>
  }
  if (!data.available) return <div className="nx-empty">{nt('handbook.unavailableBody')}</div>
  const latest = [...data.changes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, CHANGES)
  return (
    <>
      {latest.length === 0
        ? <div className="nx-empty">{nt('agents.work.noChanges')}</div>
        : (
          <div className="nx-rows">
            {latest.map((c) => (
              <div key={c.n} className="nx-row nx-agents-change">
                <span className="nx-row__text">
                  <span className="nx-mono nx-agents-change__path">{c.path}</span>
                  <span className="nx-row__hint">{nt(`agents.work.${c.kind}`)} · {relative(c.at, locale)}</span>
                  {/* Only a message the viewer may read: the server leaves the rest hidden. */}
                  {c.instruction?.visible && c.instruction.text && <span className="nx-agents-change__why">{c.instruction.text}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      <a className="nx-btn nx-btn--outline nx-btn--sm" href={withRoute(route, { params: { view: 'handbook' } })} onClick={linkClick}>
        {nt('agents.work.openHandbook')}
      </a>
    </>
  )
}

export function AgentWork({ p }: { p: Participant }) {
  const nt = useNT()
  return (
    <div className="nx-agents-work">
      <div className="nx-agents-work__screen"><Screen key={p.id} agent={p} /></div>
      <div className="nx-agents-work__side">
        <section className="nx-agents-block">
          <h3>{nt('agents.work.coding')}</h3>
          <CodingList agents={[p]} />
        </section>
        <section className="nx-agents-block">
          <h3>{nt('agents.work.handbook')}</h3>
          <Changes agentId={p.id} />
        </section>
      </div>
    </div>
  )
}
