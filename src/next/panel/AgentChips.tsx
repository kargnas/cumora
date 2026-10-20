/**
 * Picks one of the room's agents (`?agent=`). The Handbook tab and Edit share
 * the pick, so the same agent stays in view between them.
 */
import type { Participant } from '@/types'
import { useNT } from '../i18n'
import { getRoute, navigate, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'

/** The agent the URL names, or the room's first one. */
export function usePickedAgent(agents: Participant[]): Participant | undefined {
  const route = useRoute()
  return agents.find((a) => a.id === route.search.get('agent')) ?? agents[0]
}

/** Chips for a room with several agents; nothing for one. */
export function AgentChips({ agents, picked }: { agents: Participant[]; picked: Participant }) {
  const nt = useNT()
  if (agents.length < 2) return null
  return (
    <div className="nx-agent-chips" role="group" aria-label={nt('panel.agents')}>
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className="nx-agent-chip"
          aria-pressed={a.id === picked.id}
          onClick={() => {
            if (a.id === picked.id) return
            // Another agent has other change times, so the Handbook's scrubber starts at now.
            navigate(withRoute(getRoute(), { params: { agent: a.id, at: null } }), { replace: true })
          }}
        >
          <Avatar p={a} size={20} />
          <span>{a.name}</span>
        </button>
      ))}
    </div>
  )
}
