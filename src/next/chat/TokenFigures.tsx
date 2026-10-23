/**
 * Developer token figures (chat/tokens.ts): the line under the agents' reply
 * bubble and the details dialog it opens, and the digest of the agenda turns
 * after a message. On a touch screen the line is too small to aim at, so the
 * message's long-press sheet opens the same details (MessageList's Bubble).
 * Nothing renders unless developer mode filled the store.
 */
import { useCallback, useRef, useState } from 'react'
import { useLocale } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'
import { useNT, type NT } from '../i18n'
import { clock, clockRange, exactTime } from '../format'
import { Dialog } from '../ui/primitives'
import { IChevronRight, IInfo, IRepeat } from '../ui/icons'
import type { AgentFigures, Figures } from './tokenSpans'
import { openFigures, useTokens } from './tokens'

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const FULL = new Intl.NumberFormat('en')
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/** "ctx 347K/1M · cache 99.4%": what fits under a bubble; empty without either.
 *  `first`: an earlier context, shown as where it grew from ("ctx 393.7K → 406.1K/1M"). */
function summary(f: Figures, nt: NT, first: number | null = null): string {
  const now = f.ctx === null ? null : f.window ? `${COMPACT.format(f.ctx)}/${COMPACT.format(f.window)}` : COMPACT.format(f.ctx)
  const ctx = now && first !== null ? `${COMPACT.format(first)} → ${now}` : now
  const parts = [ctx && nt('tokens.ctx', { ctx }), f.hit !== null && nt('tokens.cache', { hit: pct(f.hit) })]
  return parts.filter(Boolean).join(' · ')
}

/** A steady agenda turn reads about 99.7% of its prompt from the cache, so a
 *  turn under this one sent thousands of tokens around it at these context sizes. */
const LOW_CACHE = 0.9
/** The tallest bar: a turn whose context fills its model's window. */
const BAR_PX = 64

/** The prompt tokens of a turn that did not come from the cache: cache writes and the uncached rest. */
const missed = (f: Figures) => f.agents.reduce((n, a) => n + a.input + a.write, 0)

/** Under the agents' last reply after one of my messages: the agents' calls
 *  from my message to my next one. */
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

/** The agenda turns that ran after this message, as one digest row: the agent,
 *  how many turns ran and when, the context from the first turn to the latest
 *  and the cache hit over all of them. A click opens a bar and a row per turn.
 *  Turns whose cache hit fell share one line under it, however many there are. */
export function AgendaTurns({ msgId }: { msgId: string }) {
  const nt = useNT()
  const locale = useLocale()
  const card = useTokens((s) => s.cardAfter[msgId])
  const agentId = card?.figures.agents[0]?.agentId
  const name = useParticipants((s) => (agentId ? s.byId[agentId]?.name ?? agentId : ''))
  const [open, setOpen] = useState(false)
  if (!card) return null
  const { turns, figures } = card
  const first = turns[0]
  const when = turns.length === 1
    ? clock(new Date(first.from), locale)
    : clockRange(new Date(first.from), new Date(turns[turns.length - 1].from), locale)
  const low = turns.filter((t) => t.hit !== null && t.hit < LOW_CACHE)
  const lowest = low.reduce<Figures | null>((m, t) => (m && m.hit! <= t.hit! ? m : t), null)
  // Turns from rows without a window still get bars, scaled to the largest of them.
  const scale = figures.window ?? Math.max(...turns.map((t) => t.ctx ?? 0))
  return (
    <div className="nx-agenda">
      <div className="nx-agenda__box">
        <button type="button" className="nx-agenda__digest" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <IRepeat aria-hidden />
          <span className="nx-agenda__head">
            <b>{name}</b> · {turns.length === 1 ? nt('tokens.oneTurn') : nt('tokens.turns', { n: turns.length })} · {when}
          </span>
          <IChevronRight className="nx-agenda__chev" />
          <span className="nx-agenda__figs nx-mono">{summary(figures, nt, turns.length > 1 ? first.ctx : null)}</span>
        </button>
        {open && (
          <div className="nx-agenda__more">
            {/* The table below carries the same numbers for screen readers. */}
            <div className="nx-agenda__bars" aria-hidden>
              {turns.map((t) => {
                const height = scale > 0 ? ((t.ctx ?? 0) / scale) * BAR_PX : 0
                const read = height * (t.hit ?? 0)
                return (
                  <span key={t.from} title={[clock(new Date(t.from), locale), summary(t, nt)].join(' · ')}>
                    <span className="nx-agenda__bar">
                      {height - read >= 1 && <span data-rest style={{ height: height - read }} />}
                      <span style={{ height: read }} />
                    </span>
                  </span>
                )
              })}
            </div>
            <p className="nx-agenda__legend">
              <span><i data-read />{nt('tokens.fromCache')}</span>
              <span><i />{nt('tokens.notFromCache')}</span>
            </p>
            <table className="nx-agenda__table nx-mono">
              <thead><tr><th>{nt('tokens.colTurn')}</th><th>{nt('tokens.colContext')}</th><th>{nt('tokens.cacheHit')}</th></tr></thead>
              <tbody>
                {turns.map((t) => (
                  <tr key={t.from}>
                    <td>{clock(new Date(t.from), locale)}</td>
                    <td>{t.ctx === null ? '—' : t.window ? `${COMPACT.format(t.ctx)}/${COMPACT.format(t.window)}` : COMPACT.format(t.ctx)}</td>
                    <td data-low={(t.hit !== null && t.hit < LOW_CACHE) || undefined}>{t.hit === null ? '—' : pct(t.hit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {lowest && (
        <p className="nx-agenda__low">
          <IInfo />
          {low.length === 1
            ? nt('tokens.lowOne', { time: clock(new Date(lowest.from), locale), hit: pct(lowest.hit!), n: COMPACT.format(missed(lowest)) })
            : nt('tokens.lowMany', { n: low.length, limit: `${LOW_CACHE * 100}%`, hit: pct(lowest.hit!), time: clock(new Date(lowest.from), locale) })}
        </p>
      )}
    </div>
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
