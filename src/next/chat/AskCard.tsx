/**
 * The card under an agent's question (./cards.ts): options to pick from, or a
 * field for a secret. It stays after the answer and shows it in place of the
 * person's reply, which the transcript leaves out.
 */
import { memo, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError } from '@/api/client'
import { useLocale } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { exactTime, fullDate } from '../format'
import { Avatar } from '../ui/Avatar'
import { Spinner } from '../ui/primitives'
import { ICheck, IEye, IEyeOff, ILock } from '../ui/icons'
import { useCards, type Card } from './cards'

/** A 409 means someone answered first; their answer arrives as the card's update. */
function lostRace(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409
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
  const [busy, setBusy] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  // An answer fades in only when it arrives while this card is on screen.
  const wasOpen = useRef(card.answer === null)
  const pick = async (option: number) => {
    setBusy(option)
    setFailed(false)
    try {
      await useCards.getState().answer(card, option)
      haptic('success')
    } catch (e) {
      if (!lostRace(e)) {
        setFailed(true)
        haptic('error')
      }
    } finally {
      setBusy(null)
    }
  }
  const answer = card.answer
  return (
    <>
      {showQuestion && <div className="nx-ask__q">{card.question}</div>}
      {answer && answer.option !== null ? (
        <Answered by={answer.by} at={answer.at} text={card.options[answer.option] ?? ''} rise={wasOpen.current} />
      ) : (
        <div className="nx-ask__options">
          {card.options.map((option, i) => (
            <button
              key={option}
              type="button"
              className="nx-ask__option"
              disabled={busy !== null}
              aria-busy={busy === i || undefined}
              onClick={() => void pick(i)}
            >
              <span>{option}</span>
              {busy === i && <Spinner />}
            </button>
          ))}
        </div>
      )}
      {failed && <div className="nx-ask__error" role="alert">{nt('ask.failed')}</div>}
    </>
  )
}

function Answered({ by, at, text, rise }: { by: string; at: string; text: string; rise: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const who = useParticipants((s) => s.byId[by])
  const when = new Date(at)
  const title = nt('ask.answeredBy', { name: who?.name ?? nt('msg.someone'), time: `${fullDate(when, locale)} ${exactTime(when, locale)}` })
  return (
    <div className="nx-ask__answer" data-rise={rise || undefined} title={title}>
      {who && <Avatar p={who} size={20} />}
      <span>{text}</span>
    </div>
  )
}

/**
 * A masked text field, not a password field: a browser offers to save what a
 * password field sends, and would keep the secret in its password manager.
 */
function Secret({ card }: { card: Card }) {
  const nt = useNT()
  const agent = useParticipants((s) => s.byId[card.agentId]?.name) ?? nt('msg.someone')
  const sender = useParticipants((s) => (card.answer ? s.byId[card.answer.by]?.name : undefined)) ?? nt('msg.someone')
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const wasOpen = useRef(card.answer === null)

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
    setFailed(false)
    try {
      await useCards.getState().sendSecret(card, value)
      setValue('')
      haptic('success')
    } catch (e) {
      if (!lostRace(e)) {
        setFailed(true)
        haptic('error')
      }
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }
  return (
    <div className="nx-ask__secret">
      <div className="nx-ask__field">
        <input
          className="nx-input"
          type="text"
          data-masked={!shown || undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
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
      {failed && <div className="nx-ask__error" role="alert">{nt('ask.failed')}</div>}
    </div>
  )
}
