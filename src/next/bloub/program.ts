/**
 * What a bloub avatar plays for what its agent is doing. Pure data and time:
 * the director (director.ts) owns the clock and the engines.
 */
import type { Computer, Participant } from '@/types'
import type { StateId } from './engine/states'
import type { ToolKind } from './tools'

export type Mode = 'idle' | 'thinking' | 'working' | 'waiting' | 'offline'

/** Read like the presence dot (ui/Avatar.tsx usePresence): an agent whose own
 *  computer is offline is offline, whatever status it last reported. */
export function modeOf(p: Participant, host: Computer | undefined): Mode {
  if (p.departedAt) return 'offline'
  if (host && host.kind !== 'cloud' && host.status !== 'online') return 'offline'
  switch (p.status) {
    case 'thinking': return 'thinking'
    case 'working': return 'working'
    case 'waiting': return 'waiting'
    case 'resting': return 'offline'
    default: return 'idle'
  }
}

/** A state held for some seconds (Infinity: until the mode changes), with the
 *  tool it acts out, if any (tools.ts). */
export type Step = readonly [StateId, number, ToolKind?]

/** Steps played in order; after the last one, play resumes at `loop`. */
export interface Program { steps: readonly Step[]; loop: number }

const BUSY = new Set<Mode>(['thinking', 'working', 'waiting'])

const BASE: Record<Mode, readonly Step[]> = {
  idle: [['idle', Infinity]],
  thinking: [['thinking', Infinity]],
  // play's swoosh is gone by 2.2 s and orbit's rings by 3.6 s, so work
  // alternates the two at their measured lengths instead of holding either.
  working: [['play', 2], ['orbit', 3.4]],
  waiting: [['notify', Infinity]],
  offline: [['sleep', Infinity]],
}

// burst collapses the body to a dot the size of thinking's dots by 0.7 s and
// regrows it from 1.7 s, so cut at 1.5 s the next state starts from that dot.
const TURN_START: Step = ['burst', 1.5]
// comet shrinks to a dot, trails its ribbons and is a ball with eyes again by 2.45 s.
const TURN_END: Step = ['comet', 2.45]
/** The agent posted a message. */
export const POSTED: Step = ['wink', 1.6]

/** The program for `to`. A live change into a turn opens with burst and the
 *  end of one closes with comet; `from` is null when there is no change to
 *  mark, such as an avatar just mounted. Work with a known kind of tool acts
 *  it out on the resting body instead of the generic play and orbit. */
export function programFor(from: Mode | null, to: Mode, tool: ToolKind | null = null): Program {
  const intro = from === null ? null
    : !BUSY.has(from) && BUSY.has(to) ? TURN_START
      : BUSY.has(from) && to === 'idle' ? TURN_END
        : null
  const base = baseOf(to, tool)
  return intro ? { steps: [intro, ...base], loop: 1 } : { steps: base, loop: 0 }
}

const baseOf = (mode: Mode, tool: ToolKind | null): readonly Step[] =>
  mode === 'working' && tool ? [['idle', Infinity, tool]] : BASE[mode]

/** One step, then the mode's own program again. */
export function flash(step: Step, mode: Mode, tool: ToolKind | null = null): Program {
  return { steps: [step, ...baseOf(mode, tool)], loop: 1 }
}

export interface Playhead { program: Program; index: number; since: number }

/** Moves the playhead past every step that has ended by `now`, calling
 *  `enter` for each step it starts, with the time that step started. */
export function advance(head: Playhead, now: number, enter: (state: StateId, at: number) => void): void {
  const { steps, loop } = head.program
  let cycle = 0
  for (let i = loop; i < steps.length; i++) cycle += steps[i][1]
  for (;;) {
    // A view off screen is not advanced, so one shown again after an hour
    // would replay every step it missed in one frame. A whole loop lands back
    // on the same step, so the whole loops are skipped instead.
    if (head.index >= loop && Number.isFinite(cycle) && cycle > 0 && now - head.since > cycle) {
      head.since += Math.floor((now - head.since) / cycle) * cycle
    }
    const end = head.since + steps[head.index][1]
    if (end > now) return
    head.index = head.index + 1 < steps.length ? head.index + 1 : loop
    head.since = end
    enter(steps[head.index][0], end)
  }
}
