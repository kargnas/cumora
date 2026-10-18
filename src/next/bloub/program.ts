/**
 * What a bloub avatar plays for what its agent is doing. Pure data and time:
 * the director (director.ts) owns the clock and the engines.
 */
import type { Computer, Participant } from '@/types'
import type { StateId } from './engine/states'

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

/** A state held for some seconds; Infinity holds it until the mode changes. */
export type Step = readonly [StateId, number]

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
 *  mark, such as an avatar just mounted. */
export function programFor(from: Mode | null, to: Mode): Program {
  const intro = from === null ? null
    : !BUSY.has(from) && BUSY.has(to) ? TURN_START
      : BUSY.has(from) && to === 'idle' ? TURN_END
        : null
  return intro ? { steps: [intro, ...BASE[to]], loop: 1 } : { steps: BASE[to], loop: 0 }
}

/** One step, then the mode's own program again. */
export function flash(step: Step, mode: Mode): Program {
  return { steps: [step, ...BASE[mode]], loop: 1 }
}

export interface Playhead { program: Program; index: number; since: number }

/** Moves the playhead past every step that has ended by `now`, calling
 *  `enter` for each step it starts, with the time that step started. */
export function advance(head: Playhead, now: number, enter: (state: StateId, at: number) => void): void {
  for (;;) {
    const end = head.since + head.program.steps[head.index][1]
    if (end > now) return
    head.index = head.index + 1 < head.program.steps.length ? head.index + 1 : head.program.loop
    head.since = end
    enter(head.program.steps[head.index][0], end)
  }
}
