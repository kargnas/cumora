/**
 * Computers: where agents run. Cumora Cloud is built in; a paired machine
 * reports its engines through its own daemon, so everything shown for a
 * machine comes from that machine, never from a scan of the device that is
 * showing this page.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { api, getPairingServerOrigin } from '@/api/client'
import { ENGINE_BIN, RUNNABLE_ENGINES, RUNNABLE_ENGINE_IDS, engineLabel, type RunnableEngineId } from '@/lib/engines'
import { useAuth } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { usePairingCodes } from '@/stores/pairing-codes'
import { useParticipants } from '@/stores/participants'
import type { Computer, ComputerKind, DetectedEngine, EngineId, Participant } from '@/types'
import { useNT } from '../../i18n'
import { getRoute, type Route } from '../../router'
import { Dialog, IconButton, Menu, Segmented, Spinner, T_FAST, useMenu } from '../../ui/primitives'
import { IChevronDown, IComputer, IMore, IPlus, ITrash } from '../../ui/icons'
import {
  Block, closeSheet, CopyCode, count, ErrorLine, errorText, ICloud, IServer, openSheet, Pending, setParams,
  SkeletonRows, SwitchRow,
} from './parts'

// The order people look for engines in; anything unknown goes last.
const CLI_ORDER = ['claude', 'cursor', 'codex', 'grok', 'opencode', 'pi', 'gemini', 'qwen', 'zcode', 'hermes']

/** What the machine's daemon reported. Daemons from before engine detection
 *  only sent ids, so those become rows without a path. */
function engineRows(c: Computer): DetectedEngine[] {
  const rows = c.detectedEngines && c.detectedEngines.length > 0
    ? c.detectedEngines
    : c.availableEngines.map((id): DetectedEngine => ({ id, bin: ENGINE_BIN[id] ?? id, path: null }))
  const rank = (id: string) => {
    const i = CLI_ORDER.indexOf(id)
    return i === -1 ? CLI_ORDER.length : i
  }
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id))
}

/** Engines Cumora can drive; the rest are detected but cannot run agents. */
function runnable(id: string): EngineId | null {
  return RUNNABLE_ENGINE_IDS.has(id) && id !== 'managed' ? (id as EngineId) : null
}

function pairCommand(code: string, flags = ''): string {
  const origin = getPairingServerOrigin()
  return `npx cumora@latest agent computer --pair ${code}${origin ? ` --server ${origin}` : ''}${flags}`
}

/** Agents per computer id; '' collects agents with no computer (cloud). */
function agentCounts(byId: Record<string, Participant>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of Object.values(byId)) {
    if (p.kind !== 'agent' || p.departedAt) continue
    const key = p.computerId ?? ''
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

function KindIcon({ kind }: { kind: ComputerKind }) {
  return <span className="nx-me-kind">{kind === 'cloud' ? <ICloud /> : kind === 'vps' ? <IServer /> : <IComputer />}</span>
}

function EngineRow({ c, row }: { c: Computer; row: DetectedEngine }) {
  const nt = useNT()
  const id = runnable(row.id)
  const defaults = id ? c.engineDefaults?.[id] : undefined
  const main = defaults?.model?.trim()
  const fast = defaults?.fastModel?.trim()
  const versions = [
    row.version ? nt('me.engines.installed', { version: row.version }) : nt('me.engines.unknown'),
    row.latest ? nt('me.engines.latest', { version: row.latest }) : null,
    !row.outdated && row.latest && row.version === row.latest ? nt('me.engines.current') : null,
  ].filter(Boolean).join(' · ')
  return (
    <li className="nx-me-engine">
      <div className="nx-me-engine__top">
        <b>{engineLabel(row.id)}</b>
        {row.outdated && <span className="nx-chip nx-me-chip--warn">{nt('me.engines.updateAvailable')}</span>}
        {/* Two different things: "not used" is a supported engine refused
            here for a reason the operator can fix; "detected only" means
            Cumora has no adapter for it at all. */}
        {row.blockedReason
          ? <span className="nx-chip nx-me-chip--danger">{nt('me.engines.blocked')}</span>
          : !id && <span className="nx-me-row__hint">{nt('me.engines.detectOnly')}</span>}
      </div>
      {row.blockedReason && <p className="nx-me-engine__blocked">{nt('me.engines.blockedReason', { reason: row.blockedReason })}</p>}
      <p className="nx-me-engine__path nx-mono">{row.path ? `${row.bin} · ${row.path}` : row.bin}</p>
      {(row.version || row.latest) && <p className="nx-me-row__hint">{versions}</p>}
      {row.updateCommand && (
        <div className="nx-me-engine__update">
          {/* The command updates that machine; pasting it here would update the wrong one. */}
          <p className="nx-me-row__hint">{nt('me.engines.runOn', { name: c.name })}</p>
          <CopyCode value={row.updateCommand} />
        </div>
      )}
      {id && (
        <div className="nx-me-engine__models">
          <span className="nx-me-chips">
            {main || fast ? (
              <>
                {main && <span className="nx-chip nx-mono">{main}</span>}
                {fast && <span className="nx-chip nx-mono">{nt('me.engines.fast', { model: fast })}</span>}
              </>
            ) : <span className="nx-me-row__hint">{nt('me.engines.modelsDefault')}</span>}
          </span>
          <button
            type="button"
            className="nx-btn nx-btn--outline nx-btn--sm"
            onClick={() => openSheet(getRoute(), 'models', { of: c.id, engine: row.id })}
          >
            {nt('me.engines.configure')}
          </button>
        </div>
      )}
    </li>
  )
}

const ComputerCard = memo(function ComputerCard({ c, agents, open }: { c: Computer; agents: number; open: boolean }) {
  const nt = useNT()
  const menu = useMenu()
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const cloud = c.kind === 'cloud'
  const rows = cloud ? [] : engineRows(c)

  const refreshEngines = async () => {
    setDetecting(true)
    setError(null)
    try {
      const before = c.enginesDetectedAt ?? null
      await api.requestComputerEngineDetect(c.id)
      // The daemon picks the request up on its next heartbeat and reports a
      // fresh snapshot; wait for that report instead of trusting a cached GET.
      const deadline = Date.now() + 50_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 750))
        if (!alive.current) return
        await useComputers.getState().refresh()
        const after = useComputers.getState().byId[c.id]?.enginesDetectedAt ?? null
        if (after && after !== before) return
      }
      throw new Error(nt('me.computers.refreshTimedOut'))
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setDetecting(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(nt('me.computers.removeConfirm', { name: c.name }))) return
    setError(null)
    try {
      await api.deleteComputer(c.id)
      if (getRoute().search.get('computer') === c.id) setParams(getRoute(), { computer: null })
      await useComputers.getState().refresh()
    } catch (e) {
      if (alive.current) setError(errorText(e))
    }
  }

  const summary = [
    cloud ? c.availableEngines.map(engineLabel).join(', ') : null,
    !cloud && rows.length > 0 ? count(nt, rows.length, 'me.computers.engineOne', 'me.computers.engines') : null,
    count(nt, agents, 'me.computers.agentOne', 'me.computers.agents'),
    c.daemonVersion ? nt('me.computers.daemon', { version: c.daemonVersion }) : null,
  ].filter(Boolean).join(' · ')

  const text = (
    <>
      <KindIcon kind={c.kind} />
      <span className="nx-me-row__text">
        <span className="nx-me-computer__title">
          <b>{c.name}</b>
          <span className="nx-me-status"><i className="nx-me-dot" data-s={c.status} />{nt(`me.computers.status.${c.status}`)}</span>
          {c.daemonOutdated && <span className="nx-chip nx-me-chip--warn">{nt('me.computers.updateChip')}</span>}
        </span>
        <span className="nx-me-row__hint">{summary}</span>
      </span>
    </>
  )

  return (
    <div className="nx-me-computer">
      <div className="nx-me-computer__head">
        {cloud ? (
          <div className="nx-me-computer__main">{text}</div>
        ) : (
          <button
            type="button"
            className="nx-me-computer__main"
            aria-expanded={open}
            onClick={() => setParams(getRoute(), { computer: open ? null : c.id })}
          >
            {text}
            <IChevronDown className="nx-me-chevron" />
          </button>
        )}
        {!cloud && (
          <IconButton label={nt('me.computers.actions', { name: c.name })} onClick={(e) => menu.toggleFrom(e.currentTarget, 'end')}>
            <IMore />
          </IconButton>
        )}
      </div>
      {detecting && <Pending>{nt('me.computers.refreshing', { name: c.name })}</Pending>}
      {error && <ErrorLine message={error} />}
      <AnimatePresence initial={false}>
        {open && !cloud && (
          <motion.div key="engines" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={T_FAST}>
            {rows.length === 0 ? (
              <p className="nx-me-computer__note">{nt('me.engines.none')}</p>
            ) : (
              <ul className="nx-me-engines">{rows.map((row) => <EngineRow key={row.id} c={c} row={row} />)}</ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {!cloud && (
        <Menu
          open={menu.open}
          anchor={menu.anchor}
          onClose={menu.close}
          entries={[
            { key: 'refresh', label: nt('me.computers.refresh'), disabled: detecting, onSelect: () => void refreshEngines() },
            { key: 'reconnect', label: nt('me.computers.reconnect'), onSelect: () => openSheet(getRoute(), 'repair', { of: c.id }) },
            'sep',
            { key: 'remove', label: nt('me.computers.remove'), icon: <ITrash />, danger: true, onSelect: () => void remove() },
          ]}
        />
      )}
    </div>
  )
})

/** Shown while any paired daemon is behind; it goes away on its own once the
 *  daemon restarts onto the latest version (the next heartbeat clears it). */
function DaemonNotice({ list }: { list: Computer[] }) {
  const nt = useNT()
  const outdated = list.filter((c) => c.daemonOutdated)
  if (outdated.length === 0) return null
  const one = outdated.length === 1 ? outdated[0] : null
  const latest = outdated.map((c) => c.latestDaemonVersion).find(Boolean) ?? null
  // A service daemon restarts through its supervisor; a foreground one has to
  // be stopped and run again. Old daemons that do not say which get the
  // restart command, which explains itself when no service exists.
  const manual = outdated.filter((c) => c.daemonSupervised === false)
  const allManual = manual.length === outdated.length
  const cmd = allManual ? 'npx cumora@latest agent computer' : 'npx cumora@latest agent computer --restart'
  const names = (cs: Computer[]) => cs.map((c) => c.name).join(', ')
  return (
    <div className="nx-me-notice" role="status">
      <div className="nx-me-notice__head">
        <b>{nt('me.daemon.title')}</b>
        {latest && (
          <span className="nx-me-chips nx-mono">
            {one?.daemonVersion && <span className="nx-chip">{nt('me.version', { version: one.daemonVersion })}</span>}
            <span aria-hidden>→</span>
            <span className="nx-chip nx-me-chip--warn">{nt('me.version', { version: latest })}</span>
          </span>
        )}
      </div>
      <p className="nx-me-text">
        {one ? nt('me.daemon.one', { name: one.name }) : nt('me.daemon.many', { n: outdated.length, names: names(outdated) })}
        {' '}
        {allManual
          ? nt(one ? 'me.daemon.manual' : 'me.daemon.manualMany')
          : nt(one ? 'me.daemon.restart' : 'me.daemon.restartMany')}
        {!allManual && manual.length > 0 && <>{' '}{nt('me.daemon.mixed', { names: names(manual) })}</>}
      </p>
      <CopyCode value={cmd} />
    </div>
  )
}

function PairBody() {
  const nt = useNT()
  const companyId = useAuth((s) => s.activeCompanyId)
  const code = usePairingCodes((s) => (s.companyId === companyId ? s.code : null))
  const [engine, setEngine] = useState<RunnableEngineId>('claude')
  const [service, setService] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!companyId) return
    let live = true
    setError(null)
    // Another screen may have left a code in the shared store; read the
    // current one fresh. Requesting a code never rotates it.
    const version = usePairingCodes.getState().beginRequest(companyId, true)
    api.requestPairingCode().then(
      (r) => usePairingCodes.getState().setCodeIfCurrent(companyId, version, r.code),
      (e) => { if (live) setError(errorText(e)) },
    )
    // The code is a secret: it leaves memory with the dialog.
    return () => {
      live = false
      usePairingCodes.getState().clear()
    }
  }, [companyId, attempt])
  // Without a flag the daemon picks Claude; any other default has to be
  // named, or auto-detection lets whichever engine is first on PATH win.
  const flags = (engine === 'claude' ? '' : ` --engine ${engine}`) + (service ? ' --install-service' : '')
  return (
    <div className="nx-me-form">
      <p className="nx-me-text">{nt('me.pair.hint')}</p>
      <div className="nx-field">
        <span className="nx-field__label">{nt('me.pair.engine')}</span>
        <Segmented
          label={nt('me.pair.engine')}
          value={engine}
          onChange={setEngine}
          items={RUNNABLE_ENGINES.map((id) => ({ key: id, label: engineLabel(id) }))}
        />
        <span className="nx-me-note">{nt('me.pair.engineHint')}</span>
      </div>
      <div className="nx-me-card">
        <SwitchRow label={nt('me.pair.service')} hint={nt('me.pair.serviceHint')} checked={service} onChange={setService} />
      </div>
      {error
        ? <ErrorLine message={error} onRetry={() => setAttempt((n) => n + 1)} />
        : code ? <CopyCode value={pairCommand(code, flags)} /> : <Pending>{nt('me.generating')}</Pending>}
      <p className="nx-me-note">{nt('me.pair.codeNote')}</p>
      <div className="nx-me-actions">
        <button type="button" className="nx-btn nx-btn--primary" onClick={() => closeSheet('pair')}>{nt('me.done')}</button>
      </div>
    </div>
  )
}

function RepairBody({ computer }: { computer: Computer }) {
  const nt = useNT()
  const [state, setState] = useState<{ code: string | null; error: string | null }>({ code: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setState({ code: null, error: null })
    api.repairComputer(computer.id).then(
      (r) => { if (live) setState({ code: r.code, error: null }) },
      (e) => { if (live) setState({ code: null, error: errorText(e) }) },
    )
    return () => { live = false }
  }, [computer.id, attempt])
  return (
    <div className="nx-me-form">
      <p className="nx-me-text">{nt('me.repair.hint', { name: computer.name })}</p>
      {state.error
        ? <ErrorLine message={state.error} onRetry={() => setAttempt((n) => n + 1)} />
        : state.code ? <CopyCode value={pairCommand(state.code)} /> : <Pending>{nt('me.generating')}</Pending>}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn nx-btn--primary" onClick={() => closeSheet('repair')}>{nt('me.done')}</button>
      </div>
    </div>
  )
}

function ModelsForm({ computer, engine }: { computer: Computer; engine: EngineId }) {
  const nt = useNT()
  const current = computer.engineDefaults?.[engine]
  const [main, setMain] = useState(current?.model ?? '')
  const [fast, setFast] = useState(current?.fastModel ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateEngineDefaults(computer.id, { [engine]: { model: main.trim() || null, fastModel: fast.trim() || null } })
      await useComputers.getState().refresh()
      closeSheet('models')
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <form className="nx-me-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <p className="nx-me-text">{nt('me.models.on', { name: computer.name })}</p>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.models.main')}</span>
        <input className="nx-input nx-mono" value={main} disabled={busy} placeholder={nt('me.models.mainPh')} autoComplete="off" spellCheck={false} onChange={(e) => setMain(e.target.value)} />
      </label>
      <label className="nx-field">
        <span className="nx-field__label">{nt('me.models.fast')}</span>
        <input className="nx-input nx-mono" value={fast} disabled={busy} placeholder={nt('me.models.fastPh')} autoComplete="off" spellCheck={false} onChange={(e) => setFast(e.target.value)} />
      </label>
      <p className="nx-me-note">{nt('me.models.help')}</p>
      {error && <ErrorLine message={error} />}
      <div className="nx-me-actions">
        <button type="button" className="nx-btn" onClick={() => closeSheet('models')}>{nt('me.cancel')}</button>
        <button type="submit" className="nx-btn nx-btn--primary" disabled={busy}>
          {busy && <Spinner />}
          {nt('me.save')}
        </button>
      </div>
    </form>
  )
}

/** Owners can retire the workspace code; paired machines keep working. */
function PairingCodeBlock() {
  const nt = useNT()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const rotate = async () => {
    if (!window.confirm(nt('me.pairing.confirm'))) return
    setState('busy')
    setError(null)
    // A code cached by another screen dies with the rotation.
    usePairingCodes.getState().clear()
    try {
      await api.rotatePairingCode()
      setState('done')
    } catch (e) {
      setError(errorText(e))
      setState('idle')
    }
  }
  return (
    <Block title={nt('me.pairing.title')} hint={nt('me.pairing.hint')}>
      <div className="nx-me-actions nx-me-actions--start">
        <button type="button" className="nx-btn nx-btn--outline" disabled={state === 'busy'} onClick={() => void rotate()}>
          {state === 'busy' && <Spinner />}
          {nt('me.pairing.rotate')}
        </button>
      </div>
      {state === 'done' && <p className="nx-me-note" role="status">{nt('me.pairing.rotated')}</p>}
      {error && <ErrorLine message={error} />}
    </Block>
  )
}

export function ComputersPage({ route }: { route: Route }) {
  const nt = useNT()
  const loaded = useComputers((s) => s.loaded)
  const byId = useComputers((s) => s.byId)
  const owner = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.role === 'owner')
  const agents = useParticipants(useShallow((s) => agentCounts(s.byId)))
  const [failed, setFailed] = useState(false)
  const list = useMemo(() => Object.values(byId).sort((a, b) =>
    (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1) || a.name.localeCompare(b.name)), [byId])
  const expanded = route.search.get('computer')
  const sheet = route.search.get('sheet')
  const target = route.search.get('of')
  const sheetComputer = target ? byId[target] ?? null : null
  const modelsEngine = runnable(route.search.get('engine') ?? '')

  // Statuses change while nobody looks; refresh on open, quietly. The store
  // swallows fetch errors, so a failure is read back from `loaded`.
  const refresh = () => {
    setFailed(false)
    void useComputers.getState().refresh().then(() => setFailed(!useComputers.getState().loaded))
  }
  useEffect(refresh, [])

  return (
    <>
      <p className="nx-me-intro">{nt('me.computers.intro')}</p>
      <DaemonNotice list={list} />
      {!loaded ? (
        failed ? <ErrorLine message={nt('me.computers.loadFailed')} onRetry={refresh} /> : <SkeletonRows n={2} />
      ) : (
        <div className="nx-me-computers">
          {list.map((c) => (
            <ComputerCard
              key={c.id}
              c={c}
              agents={(agents[c.id] ?? 0) + (c.kind === 'cloud' ? agents[''] ?? 0 : 0)}
              open={expanded === c.id}
            />
          ))}
        </div>
      )}
      <div className="nx-me-actions nx-me-actions--start">
        <button type="button" className="nx-btn nx-btn--primary" onClick={() => openSheet(route, 'pair')}>
          <IPlus />
          {nt('me.computers.add')}
        </button>
      </div>
      {owner && <PairingCodeBlock />}
      <Dialog open={sheet === 'pair'} onClose={() => closeSheet('pair')} title={nt('me.pair.title')}>
        <PairBody />
      </Dialog>
      <Dialog
        open={sheet === 'repair' && sheetComputer !== null}
        onClose={() => closeSheet('repair')}
        title={sheetComputer ? nt('me.repair.title', { name: sheetComputer.name }) : ''}
      >
        {sheetComputer && <RepairBody computer={sheetComputer} />}
      </Dialog>
      <Dialog
        open={sheet === 'models' && sheetComputer !== null && modelsEngine !== null}
        onClose={() => closeSheet('models')}
        title={modelsEngine ? nt('me.models.title', { engine: engineLabel(modelsEngine) }) : ''}
      >
        {sheetComputer && modelsEngine && <ModelsForm computer={sheetComputer} engine={modelsEngine} />}
      </Dialog>
    </>
  )
}
