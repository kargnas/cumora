/**
 * The full agent editor (model, computer, avatar and the rest), opened from
 * the room's Edit with `?agent-edit=<id>`. It is the editor the Agents section
 * opens (the classic AgentEditor with the Look Studio as its avatar fields);
 * agents.css folds its own modal frame into the Dialog.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { useNT } from '../i18n'
import { getRoute, goBack, useRoute, withRoute } from '../router'
import { Dialog } from '../ui/primitives'
import { LookEditor } from '../sections/agents/LookStudio'
import '../sections/agents/agents.css'

export const AGENT_EDIT_PARAM = 'agent-edit'

export function AgentEditDialog() {
  const nt = useNT()
  const id = useRoute().search.get(AGENT_EDIT_PARAM)
  const agent = useParticipants((s) => (id ? s.byId[id] : undefined))
  const editing = agent?.kind === 'agent' && !agent.departedAt ? agent : null
  // Esc reaches both the Dialog and the editor's own key listener; a second
  // goBack in the same tick would also close the room panel.
  const closing = useRef(false)
  useEffect(() => { closing.current = false }, [id])
  const close = useCallback(() => {
    const r = getRoute()
    if (closing.current || !r.search.has(AGENT_EDIT_PARAM)) return
    closing.current = true
    goBack(withRoute(r, { params: { [AGENT_EDIT_PARAM]: null } }))
  }, [])
  // A rename shows in the roster, the panel header and the 1:1 room's title.
  const saved = useCallback(() => {
    void Promise.all([useParticipants.getState().refresh(), useConversations.getState().reload()])
  }, [])
  return (
    <Dialog open={editing !== null} onClose={close} title={editing ? nt('agents.editAgent', { name: editing.name }) : ''}>
      <div className="nx-agents-editor">
        {editing && <LookEditor key={editing.id} agent={editing} onClose={close} onSaved={saved} />}
      </div>
    </Dialog>
  )
}
