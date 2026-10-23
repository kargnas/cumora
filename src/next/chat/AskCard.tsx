/**
 * The card under an agent's question (./cards.ts): options to pick from and a
 * field for the person's own words, or a field for a secret. An answered
 * question keeps a summary: the answer, who gave it and when, and the other
 * options folded under it. The reply that carries the answer shows as a
 * one-line note where it was sent (AnswerLine in ./MessageList.tsx).
 */
import { memo, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError } from '@/api/client'
import { isImeComposing } from '@/lib/keyboard'
import { useLocale } from '@/lib/i18n'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { clock, exactTime, fullDate } from '../format'
import { Avatar } from '../ui/Avatar'
import { Spinner, useCoarse } from '../ui/primitives'
import { ICheck, IChevronDown, IEye, IEyeOff, ILock } from '../ui/icons'
import { useCards, type Card, type CardAnswer, type CardPick } from './cards'
import { MAX_ANSWER } from './limits'

/** A 409 means someone answered first; their answer arrives as the card's update. */
function lostRace(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409
}

/** As in the composer: Enter sends and Shift+Enter breaks a line, while on a
 *  phone Return breaks a line and the button sends. */
function sendsOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, coarse: boolean): boolean {
  if (isImeComposing(e) || e.key !== 'Enter' || e.shiftKey || (coarse && !e.metaKey && !e.ctrlKey)) return false
  e.preventDefault()
  return true
}

/** `rise`: the card came after its message was on screen, so it fades in. */
export const AskCard = memo(function AskCard({ card, showQuestion, rise }: { card: Card; showQuestion: boolean; rise: boolean }) {
  return (
    <div className="nx-ask" data-rise={rise || undefined}>
      {card.kind === 'choice' ? <Choice card={card} showQuestion={showQuestion} /> : <Secret card={card} />}
    </div>
  )
})

function Choice({ card, showQuestion }: { card: Card; showQuestion: boolean }) {
  const nt = useNT()
  const me = useMe()
  const coarse = useCoarse()
  const [busy, setBusy] = useState<number | 'text' | null>(null)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  // What this person tried to send when someone else answered first.
  const [lost, setLost] = useState<string | null>(null)
  // The summary fades in only when the answer arrives while this card is on screen.
  const wasOpen = useRef(card.answer === null)

  const send = async (pick: CardPick, tried: string) => {
    setBusy('option' in pick ? pick.option : 'text')
    setFailed(false)
    try {
      await useCards.getState().answer(card, pick)
      setDraft('')
      haptic('success')
    } catch (e) {
      if (lostRace(e)) setLost(tried)
      else {
        setFailed(true)
        haptic('error')
      }
    } finally {
      setBusy(null)
    }
  }
  const sendDraft = () => {
    const text = draft.trim()
    if (text && busy === null) void send({ text }, text)
  }

  if (card.answer) {
    // Someone else answered: what this person picked or was still typing
    // stays readable instead of vanishing with the field. My own answer never
    // shows here: the closed card reaches me before the server answers my
    // POST, and by then it already names me as the one who answered.
    const unsent = card.answer.by === me ? null : lost ?? (draft.trim() || null)
    return <Summary card={card} answer={card.answer} showQuestion={showQuestion} rise={wasOpen.current} unsent={unsent} />
  }
  return (
    <>
      <div className="nx-ask__status"><span className="nx-ask__dot" aria-hidden />{nt('ask.needsAnswer')}</div>
      {showQuestion && <div className="nx-ask__q">{card.question}</div>}
      <div className="nx-ask__options">
        {card.options.map((option, i) => (
          <button
            key={option}
            type="button"
            className="nx-ask__option"
            disabled={busy !== null}
            aria-busy={busy === i || undefined}
            onClick={() => void send({ option: i }, option)}
          >
            <span>{option}</span>
            {busy === i && <Spinner />}
          </button>
        ))}
      </div>
      <div className="nx-ask__own">
        <textarea
          className="nx-input"
          rows={1}
          maxLength={MAX_ANSWER}
          enterKeyHint={coarse ? 'enter' : 'send'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (sendsOnEnter(e, coarse)) sendDraft() }}
          placeholder={nt('ask.ownPlaceholder')}
          aria-label={nt('ask.ownLabel')}
          disabled={busy !== null}
        />
        <button
          type="button"
          className="nx-btn nx-btn--outline"
          disabled={busy !== null || !draft.trim()}
          aria-busy={busy === 'text' || undefined}
          onClick={sendDraft}
        >
          {busy === 'text' ? <Spinner /> : nt('ask.send')}
        </button>
      </div>
      {failed && <div className="nx-ask__error" role="alert">{nt('ask.failed')}</div>}
    </>
  )
}

function Summary({ card, answer, showQuestion, rise, unsent }: { card: Card; answer: CardAnswer; showQuestion: boolean; rise: boolean; unsent: string | null }) {
  const nt = useNT()
  const locale = useLocale()
  const who = useParticipants((s) => s.byId[answer.by])
  const [open, setOpen] = useState(false)
  const name = who?.name ?? nt('msg.someone')
  const when = new Date(answer.at)
  const text = answer.option === null ? answer.text ?? '' : card.options[answer.option] ?? ''
  const rest = card.options.filter((_, i) => i !== answer.option)
  return (
    <div className="nx-ask__sum" data-rise={rise || undefined}>
      {showQuestion && <div className="nx-ask__q">{card.question}</div>}
      <div className="nx-ask__result">
        <div className="nx-ask__picked"><ICheck aria-hidden /><span>{text}</span></div>
        <div className="nx-ask__by" title={nt('ask.answeredBy', { name, time: `${fullDate(when, locale)} ${exactTime(when, locale)}` })}>
          {who && <Avatar p={who} size={16} />}
          <span>{name}</span>
          <span aria-hidden>·</span>
          <time className="nx-mono" dateTime={answer.at}>{clock(when, locale)}</time>
        </div>
      </div>
      {rest.length > 0 && (
        <button type="button" className="nx-ask__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {nt('ask.others', { n: rest.length })}
          <IChevronDown aria-hidden />
        </button>
      )}
      {open && <ul className="nx-ask__others">{rest.map((o) => <li key={o}>{o}</li>)}</ul>}
      {unsent && (
        <div className="nx-ask__unsent">
          <span>{nt('ask.unsent', { name })}</span>
          <p>{unsent}</p>
        </div>
      )}
    </div>
  )
}

/**
 * A masked text field, not a password field: a browser offers to save what a
 * password field sends, and would keep the secret in its password manager. A
 * textarea, so a pasted key or certificate keeps its lines.
 */
function Secret({ card }: { card: Card }) {
  const nt = useNT()
  const agent = useParticipants((s) => s.byId[card.agentId]?.name) ?? nt('msg.someone')
  const sender = useParticipants((s) => (card.answer ? s.byId[card.answer.by]?.name : undefined)) ?? nt('msg.someone')
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasOpen = useRef(card.answer === null)
  const coarse = useCoarse()

  if (card.answer) {
    const expired = !card.takenAt && card.expiresAt !== null && Date.parse(card.expiresAt) <= Date.now()
    const text = card.takenAt
      ? nt('secret.saved', { agent })
      : expired ? nt('secret.expired', { agent }) : nt('secret.sent', { name: sender, agent })
    return (
      <div className="nx-ask__answer" data-rise={wasOpen.current || undefined} data-muted={expired || undefined}>
        {card.takenAt ? <ICheck /> : <ILock />}
        <span>{text}</span>
      </div>
    )
  }

  const send = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await useCards.getState().sendSecret(card, value)
      setValue('')
      haptic('success')
    } catch (e) {
      if (!lostRace(e)) {
        // 410: the agent that asked left the room, so nobody could take it.
        setError(e instanceof ApiError && e.status === 410 ? nt('secret.left', { agent }) : nt('ask.failed'))
        haptic('error')
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nx-ask__secret">
      <div className="nx-ask__field">
        <textarea
          className="nx-input"
          rows={1}
          enterKeyHint={coarse ? 'enter' : 'send'}
          data-masked={!shown || undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (sendsOnEnter(e, coarse)) void send() }}
          placeholder={nt('secret.placeholder')}
          aria-label={nt('secret.label')}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
        />
        <button
          type="button"
          className="nx-ask__peek"
          onClick={() => setShown(!shown)}
          aria-label={shown ? nt('secret.hide') : nt('secret.show')}
          aria-pressed={shown}
        >
          {shown ? <IEyeOff /> : <IEye />}
        </button>
      </div>
      <button type="button" className="nx-btn nx-btn--primary" disabled={busy || !value.trim()} aria-busy={busy || undefined} onClick={() => void send()}>
        {busy ? <Spinner /> : nt('secret.send')}
      </button>
      <p className="nx-ask__hint"><ILock />{nt('secret.hint', { agent })}</p>
      {error && <div className="nx-ask__error" role="alert">{error}</div>}
    </div>
  )
}
