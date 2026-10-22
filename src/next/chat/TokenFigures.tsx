/**
 * Developer token figures (chat/tokens.ts): the line at the end of the
 * agents' reply bubble, the agenda turn cards, and the details dialog they open. On a touch screen the
 * line is too small to aim at, so the message's long-press sheet opens the
 * same details (MessageList's Bubble). Nothing renders unless developer mode
 * filled the store.
 */
import { useCallback, useRef } from 'react'
import { useLocale } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'
import { useNT, type NT } from '../i18n'
import { clock, exactTime } from '../format'
import { Dialog } from '../ui/primitives'
import type { AgentFigures, Figures } from './tokenSpans'
import { openFigures, useTokens } from './tokens'

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const FULL = new Intl.NumberFormat('en')
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/** "ctx 347K/1M · cache 99.4%": what fits under a bubble; empty without either. */
function summary(f: Figures, nt: NT): string {
  const ctx = f.ctx === null ? null : f.window ? `${COMPACT.format(f.ctx)}/${COMPACT.format(f.window)}` : COMPACT.format(f.ctx)
  const parts = [ctx && nt('tokens.ctx', { ctx }), f.hit !== null && nt('tokens.cache', { hit: pct(f.hit) })]
  return parts.filter(Boolean).join(' · ')
}

/** In the agents' last reply after one of my messages, on a line of its own:
 *  the agents' calls from my message to my next one. */
export function TokenLine({ figures }: { figures: Figures }) {
  const nt = useNT()
  const text = summary(figures, nt)
  if (!text) return null
  return (
    <button type="button" className="nx-tokens nx-mono" onClick={() => openFigures(nt('tokens.title'), figures)}>
      {text}
    </button>
  )
}

/** Agenda turns that ran after this message, each as its own card. */
export function AgendaCards({ msgId }: { msgId: string }) {
  const nt = useNT()
  const locale = useLocale()
  const cards = useTokens((s) => s.cardsAfter[msgId])
  if (!cards) return null
  return (
    <>
      {cards.map((c) => (
        <div key={c.runId} className="nx-line">
          <button
            type="button"
            className="nx-tokens nx-tokens--card nx-mono"
            onClick={() => openFigures(nt('tokens.agendaTitle'), c.figures)}
          >
            {[nt('tokens.agenda', { time: clock(new Date(c.at), locale) }), summary(c.figures, nt)].filter(Boolean).join(' · ')}
          </button>
        </div>
      ))}
    </>
  )
}

function AgentBlock({ a }: { a: AgentFigures }) {
  const nt = useNT()
  const name = useParticipants((s) => s.byId[a.agentId]?.name ?? a.agentId)
  const prompt = a.input + a.read + a.write
  const rows: [string, string][] = [
    [nt('tokens.context'), a.ctx === null ? '—' : a.window ? `${FULL.format(a.ctx)} / ${FULL.format(a.window)} (${pct(a.ctx / a.window)})` : FULL.format(a.ctx)],
    [nt('tokens.cacheHit'), prompt > 0 ? pct(a.read / prompt) : '—'],
    [nt('tokens.calls'), FULL.format(a.calls)],
    [nt('tokens.input'), FULL.format(prompt)],
    [nt('tokens.cacheRead'), FULL.format(a.read)],
    [nt('tokens.cacheWrite'), FULL.format(a.write)],
    [nt('tokens.uncached'), FULL.format(a.input)],
    [nt('tokens.output'), FULL.format(a.output)],
  ]
  return (
    <section className="nx-tokens-agent">
      <h3>{name} <span className="nx-mono">{a.model}</span></h3>
      <dl>
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="nx-mono">{v}</dd></div>)}
      </dl>
      {a.subs.length > 0 && (
        <>
          <h4>{nt('tokens.subagents')}</h4>
          <ul>
            {a.subs.map((s) => (
              <li key={s.id}>
                <span>{s.description || s.type}</span>
                <span className="nx-mono">{nt('tokens.sub', { tokens: FULL.format(s.tokens), tools: s.toolUses === 1 ? nt('tokens.oneTool') : nt('tokens.tools', { n: s.toolUses }), secs: Math.round(s.durationMs / 1000) })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** The one details dialog of the transcript; rows only put figures in the store. */
export function TokenDialog() {
  const nt = useNT()
  const locale = useLocale()
  const open = useTokens((s) => s.open)
  // The figures stay on screen while the dialog animates out.
  const last = useRef(open)
  if (open) last.current = open
  const shown = open ?? last.current
  const close = useCallback(() => useTokens.setState({ open: null }), [])
  return (
    <Dialog open={open !== null} onClose={close} title={shown?.title ?? ''}>
      {shown && (
        <div className="nx-tokens-detail">
          <p className="nx-mono">
            {exactTime(new Date(shown.figures.from), locale)} → {shown.figures.to ? exactTime(new Date(shown.figures.to), locale) : nt('tokens.now')}
          </p>
          {shown.figures.agents.map((a) => <AgentBlock key={a.agentId} a={a} />)}
        </div>
      )}
    </Dialog>
  )
}
