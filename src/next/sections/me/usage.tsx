/**
 * Usage: what agents spent on this account in the gateway's rolling
 * windows. Deployments without a quota gateway, or accounts not provisioned
 * on it yet, say so instead of showing an error.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ApiQuotaResponse, type ApiQuotaWindow } from '@/api/client'
import { useLocale, type Locale } from '@/lib/i18n'
import { useNT, type NKey, type NT } from '../../i18n'
import { Spinner } from '../../ui/primitives'
import { ErrorLine, errorText, Row, SkeletonRows } from './parts'

type Period = 'daily' | 'weekly' | 'monthly'

const PERIODS: Array<{ key: Period; label: NKey; roll: NKey; ms: number }> = [
  { key: 'daily', label: 'me.usage.daily', roll: 'me.usage.rollDaily', ms: 86_400_000 },
  { key: 'weekly', label: 'me.usage.weekly', roll: 'me.usage.rollWeekly', ms: 7 * 86_400_000 },
  // The gateway's month is a rolling 30 days, not the calendar month.
  { key: 'monthly', label: 'me.usage.monthly', roll: 'me.usage.rollMonthly', ms: 30 * 86_400_000 },
]

function usd(n: number, locale: Locale): string {
  const fmt = (v: number) => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: v >= 1000 ? 0 : 2,
    maximumFractionDigits: v >= 1000 ? 0 : 2,
  }).format(v)
  return n > 0 && n < 0.01 ? `< ${fmt(0.01)}` : fmt(n)
}

/** Windows roll from their start, so the reset is start + length. */
function resetsIn(nt: NT, start: string | null, length: number): string | null {
  const t = start ? new Date(start).getTime() : Number.NaN
  if (Number.isNaN(t)) return null
  const left = t + length - Date.now()
  if (left <= 0) return nt('me.usage.resetsSoon')
  const hours = Math.floor(left / 3_600_000)
  if (hours < 1) return nt('me.usage.resetsMinutes', { n: Math.max(1, Math.floor(left / 60_000)) })
  if (hours < 48) return nt('me.usage.resetsHours', { n: hours })
  return nt('me.usage.resetsDays', { n: Math.floor(hours / 24) })
}

function QuotaRow({ period, quota }: { period: (typeof PERIODS)[number]; quota: ApiQuotaWindow }) {
  const nt = useNT()
  const locale = useLocale()
  const limit = quota.limitUsd
  const pct = limit != null && limit > 0 ? Math.min(100, (quota.usedUsd / limit) * 100) : null
  // Calm until 75%, a warning past it, red from 95%.
  const tone = pct === null || pct < 75 ? undefined : pct < 95 ? 'warn' : 'danger'
  const sub = [nt(period.roll), resetsIn(nt, quota.windowStart, period.ms)].filter(Boolean).join(' · ')
  return (
    <div className="nx-me-quota">
      <div className="nx-me-quota__top">
        <span className="nx-me-row__text">
          <span className="nx-me-row__label">{nt(period.label)}</span>
          <span className="nx-me-row__hint">{sub}</span>
        </span>
        <span className="nx-me-quota__num nx-mono">
          {limit != null ? nt('me.usage.of', { used: usd(quota.usedUsd, locale), limit: usd(limit, locale) }) : usd(quota.usedUsd, locale)}
        </span>
        {pct === null
          ? <span className="nx-chip">{nt('me.usage.unlimited')}</span>
          : <span className="nx-me-quota__pct nx-mono">{Math.round(pct)}%</span>}
      </div>
      {pct !== null && (
        <div
          className="nx-me-meter"
          data-tone={tone}
          role="progressbar"
          aria-label={nt(period.label)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
      )}
    </div>
  )
}

export function UsagePage() {
  const nt = useNT()
  const [data, setData] = useState<ApiQuotaResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setData(await api.getQuota())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  // First load: a skeleton, or the failure in its place. Later refreshes keep
  // the numbers and spin at the button.
  if (!data) {
    if (busy) return <SkeletonRows n={3} />
    return <ErrorLine message={nt('me.usage.failed', { error: error ?? '' })} onRetry={() => void load()} />
  }

  const { configured, snapshot } = data
  // With numbers on screen, a gateway hiccup is reported next to the button;
  // without them, the row above already says the gateway is unreachable.
  const failure = error ?? (snapshot ? data.error : null)
  const refresh = (
    <div className="nx-me-actions nx-me-actions--start">
      <button type="button" className="nx-btn nx-btn--outline" disabled={busy} onClick={() => void load()}>
        {busy && <Spinner />}
        {nt('me.usage.refresh')}
      </button>
      {failure && <span className="nx-me-row__error" role="alert">{nt('me.usage.refreshFailed', { error: failure })}</span>}
    </div>
  )

  if (!configured) {
    return (
      <div className="nx-me-card">
        <Row label={nt('me.usage.noGateway')} hint={nt('me.usage.noGatewayHint')} />
      </div>
    )
  }
  if (!snapshot) {
    return (
      <>
        <div className="nx-me-card">
          <Row
            label={nt(data.error ? 'me.usage.unreachable' : 'me.usage.noSubscription')}
            hint={nt(data.error ? 'me.usage.unreachableHint' : 'me.usage.noSubscriptionHint')}
          />
        </div>
        {refresh}
      </>
    )
  }
  return (
    <>
      <p className="nx-me-intro">
        {nt('me.usage.intro')}
        {snapshot.groupName && <> {nt('me.usage.plan', { plan: snapshot.groupName })}</>}
      </p>
      <div className="nx-me-card">
        {PERIODS.map((p) => <QuotaRow key={p.key} period={p} quota={snapshot[p.key]} />)}
      </div>
      {refresh}
    </>
  )
}
