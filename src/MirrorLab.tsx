import { useEffect, useMemo, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import {
  ArrowLeft, ArrowRight, CircleAlert, Crosshair,
  Fingerprint, LoaderCircle, Play, Search,
  ShieldCheck, Swords, Wallet,
} from 'lucide-react'
import { analyzeHedgeLab, evaluateHedgeAtExpiry, type HedgeLabResult } from './lab-engine'
import type { OptionSeries } from './domain'
import type { OrderIntent } from './order'
import { fetchMakerQuotes } from './quotes'
import { accountExists, fetchSolMarket, getSolBalance } from './solana'
import { deriveMarketPda, getSettlementProgramId } from './settlement'
import './mirror-lab.css'

type Props = {
  onCommit: (intent: OrderIntent) => void
  onBack: () => void
  walletAddress?: string
  makerStatus?: string
}
type Phase = 'idle' | 'attacked' | 'defended'
type AccountCheck = { state: 'unchecked' | 'checking' | 'verified' | 'failed'; detail: string }
type CurvePoint = { expirySpotUsd: number; unhedgedValueUsd: number; hedgedValueUsd: number; requiresExtraLiquiditySol: number }

const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: amount >= 1000 ? 0 : 2 }).format(amount)
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`
const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-4)}`
const asNumber = (value: string, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback

async function freshSpot(): Promise<number | null> {
  try {
    const response = await fetch('/api/spot', { signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const payload = await response.json() as { price?: number }
      if (typeof payload.price === 'number' && Number.isFinite(payload.price) && payload.price > 0) return payload.price
    }
  } catch { /* try the independent market feed */ }
  return (await fetchSolMarket())?.price ?? null
}

function shapePath(points: CurvePoint[], metric: 'unhedgedValueUsd' | 'hedgedValueUsd', bounds: { minX: number; maxX: number; maxY: number }) {
  if (!points.length) return ''
  const x = (value: number) => 52 + (value - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX) * 716
  const y = (value: number) => 246 - value / Math.max(1, bounds.maxY) * 202
  return points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.expirySpotUsd).toFixed(1)} ${y(point[metric]).toFixed(1)}`).join(' ')
}

function RealityChart({ result, phase, scenarioSpot, treasurySol, onScenarioSpot }: {
  result: HedgeLabResult | null
  phase: Phase
  scenarioSpot: number
  treasurySol: number
  onScenarioSpot: (value: number) => void
}) {
  const selected = phase === 'defended' ? result?.selected : null
  const points = useMemo<CurvePoint[]>(() => {
    if (!result) return []
    if (result.curve.length) return result.curve
    // The exposure line remains useful when a live maker quote is unavailable.
    const base = result.crashPriceUsd / Math.max(.1, 1 - .35)
    return Array.from({ length: 31 }, (_, index) => {
      const price = base * (.25 + index * .05)
      return { expirySpotUsd: price, unhedgedValueUsd: price * treasurySol, hedgedValueUsd: 0, requiresExtraLiquiditySol: 0 }
    })
  }, [result, treasurySol])
  const minX = points[0]?.expirySpotUsd ?? 0
  const maxX = points.at(-1)?.expirySpotUsd ?? 1
  const maxY = Math.max(1, ...points.map((point) => Math.max(point.unhedgedValueUsd, selected ? point.hedgedValueUsd : 0))) * 1.08
  const bounds = { minX, maxX, maxY }
  const atScenario = selected ? evaluateHedgeAtExpiry(selected, Math.max(1, scenarioSpot)) : null
  const unhedgedAtScenario = selected ? atScenario!.unhedgedValueUsd : scenarioSpot * treasurySol
  const xAtScenario = 52 + (scenarioSpot - minX) / Math.max(1, maxX - minX) * 716
  const yAtUnhedged = 246 - unhedgedAtScenario / maxY * 202
  const yAtHedged = selected && atScenario ? 246 - atScenario.hedgedValueUsd / maxY * 202 : 0
  const unbacked = selected ? points.filter((point) => point.requiresExtraLiquiditySol > .000001) : []

  return <div className="mirror-chart">
    <div className="mirror-chart-top">
      <div><strong>Branching realities</strong><small>Same SOL treasury · expiry value</small></div>
      <div className="mirror-legend"><span><i /> Unprotected</span><span className="protected"><i /> Soleil model</span></div>
    </div>
    {result && phase !== 'idle' ? <>
      <svg viewBox="0 0 820 280" role="img" aria-label="Treasury value at expiry across SOL prices, before and after the modeled put hedge">
        {[.25, .5, .75, 1].map((fraction) => <g key={fraction}>
          <line x1="52" y1={246 - fraction * 202} x2="768" y2={246 - fraction * 202} stroke="#323232" strokeDasharray="3 5" />
          <text x="45" y={250 - fraction * 202} textAnchor="end" fill="#858585" fontSize="9">{money(maxY * fraction)}</text>
        </g>)}
        <line x1="52" y1="246" x2="768" y2="246" stroke="#515151" />
        <path d={shapePath(points, 'unhedgedValueUsd', bounds)} fill="none" stroke="#8c8c8c" strokeWidth="2.2" />
        {selected && <path d={shapePath(points, 'hedgedValueUsd', bounds)} fill="none" stroke="#e2a9f1" strokeWidth="3.2" />}
        {selected && unbacked.length > 1 && <path d={shapePath(unbacked, 'hedgedValueUsd', bounds)} fill="none" stroke="#e898a3" strokeWidth="3.2" strokeDasharray="6 5" />}
        <line x1={xAtScenario} y1="44" x2={xAtScenario} y2="246" stroke="#816b89" strokeDasharray="4 4" />
        <circle cx={xAtScenario} cy={yAtUnhedged} r="5" fill="#b5b5b5" stroke="#171717" strokeWidth="2" />
        {selected && <circle cx={xAtScenario} cy={yAtHedged} r="6" fill="#e2a9f1" stroke="#171717" strokeWidth="2" />}
        <text x="52" y="267" fill="#999" fontSize="10">{money(minX)} SOL</text>
        <text x="768" y="267" textAnchor="end" fill="#999" fontSize="10">{money(maxX)} SOL</text>
      </svg>
      <div className="mirror-chart-foot">
        <div className="mirror-chart-readout">
          <span>At SOL {money(scenarioSpot)}</span>
          <strong>Without {money(unhedgedAtScenario)}</strong>
          {selected && <strong className="protected">With put {money(atScenario!.hedgedValueUsd)}</strong>}
        </div>
        <input aria-label="SOL price at option expiry" type="range" min={Math.max(1, Math.floor(minX))} max={Math.max(2, Math.ceil(maxX))} step="1" value={Math.min(Math.max(scenarioSpot, minX), maxX)} onChange={(event) => onScenarioSpot(Number(event.target.value))} />
        <span>Model only. Settlement depends on available liquidity.</span>
      </div>
    </> : <div className="mirror-chart-empty">Set the inputs, then run a stress test.</div>}
  </div>
}

export default function MirrorLab({ onCommit, onBack, walletAddress, makerStatus }: Props) {
  const [treasurySol, setTreasurySol] = useState(.1)
  const [expiryDays, setExpiryDays] = useState(7)
  const [maxPremiumUsd, setMaxPremiumUsd] = useState(5)
  const [maxDrawdownPct, setMaxDrawdownPct] = useState(20)
  const [crashDropPct, setCrashDropPct] = useState(35)
  const [spot, setSpot] = useState<number | null>(null)
  const [series, setSeries] = useState<OptionSeries[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<HedgeLabResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accountCheck, setAccountCheck] = useState<AccountCheck>({ state: 'unchecked', detail: 'Run hedge search to check devnet accounts.' })
  const [scenarioSpot, setScenarioSpot] = useState(80)
  const [walletLoading, setWalletLoading] = useState(false)
  const [nowUnix, setNowUnix] = useState(() => Math.floor(Date.now() / 1000))

  const selected = phase === 'defended' ? result?.selected : null
  const makerLabel = series.length ? 'LIVE' : spot ? 'NO QUOTES' : 'CHECKING'
  const quoteFresh = Boolean(selected && selected.quoteExpiresAt > nowUnix + 15)
  const readyToCommit = Boolean(selected && result?.audit?.passed && quoteFresh && accountCheck.state === 'verified')
  const liveCase = selected ? evaluateHedgeAtExpiry(selected, Math.max(1, scenarioSpot)) : null

  useEffect(() => {
    let active = true
    void (async () => {
      const price = await freshSpot()
      if (!price || !active) return
      setSpot(price)
      const rows = await fetchMakerQuotes(price, expiryDays, 15_000)
      if (!active) return
      setSeries(rows ?? [])
    })()
    return () => { active = false }
  }, [expiryDays])
  useEffect(() => {
    const clock = window.setInterval(() => setNowUnix(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(clock)
  }, [])

  function invalidate() {
    setPhase('idle')
    setResult(null)
    setAccountCheck({ state: 'unchecked', detail: 'Run hedge search to check devnet accounts.' })
    setError('')
  }

  async function loadMarket(): Promise<{ price: number; rows: OptionSeries[] }> {
    const price = await freshSpot()
    if (!price) throw new Error('Live SOL spot is unavailable. Retry when the market feed returns.')
    const rows = await fetchMakerQuotes(price, expiryDays, 15_000) ?? []
    setSpot(price)
    setSeries(rows)
    return { price, rows }
  }

  async function verifyDevnet(analysis: HedgeLabResult): Promise<AccountCheck> {
    const choice = analysis.selected
    const program = getSettlementProgramId()
    if (!choice || !program) return { state: 'failed', detail: 'Deployed Soleil program or eligible put quote is missing.' }
    if (choice.quoteExpiresAt <= Date.now() / 1000 + 15) return { state: 'failed', detail: 'Maker quote expired; refresh the hedge search.' }
    try {
      const market = deriveMarketPda(program, choice.strikeUsd, choice.expiryAt, 'put')
      const quoteAddress = new PublicKey(choice.quoteAddress)
      const [marketExists, quoteExists] = await Promise.all([accountExists(market), accountExists(quoteAddress)])
      if (!marketExists || !quoteExists) return { state: 'failed', detail: `${!marketExists ? 'Market' : 'Quote'} account is missing on devnet.` }
      return { state: 'verified', detail: `Market ${short(market.toBase58())} and quote ${short(choice.quoteAddress)} exist on devnet.` }
    } catch (cause) {
      return { state: 'failed', detail: cause instanceof Error ? cause.message : 'Devnet account check failed.' }
    }
  }

  async function run(kind: 'attack' | 'defend') {
    setBusy(true)
    setError('')
    if (kind === 'defend') setAccountCheck({ state: 'checking', detail: 'Reading quote and market accounts on devnet…' })
    try {
      const market = kind === 'attack' ? null : await loadMarket()
      const price = market?.price ?? await freshSpot()
      if (!price) throw new Error('Live SOL spot is unavailable. Retry when the market feed returns.')
      if (kind === 'attack') setSpot(price)
      const rows = market?.rows ?? []
      const analysis = analyzeHedgeLab({
        spotUsd: price,
        treasurySol,
        expiryDays,
        maxPremiumUsd,
        maxDrawdownPct: maxDrawdownPct / 100,
        crashDropPct: crashDropPct / 100,
        series: rows,
      })
      setResult(analysis)
      setScenarioSpot(analysis.crashPriceUsd)
      setPhase(kind === 'defend' && analysis.selected ? 'defended' : 'attacked')
      if (kind === 'defend') {
        setAccountCheck(analysis.selected
          ? await verifyDevnet(analysis)
          : { state: 'unchecked', detail: analysis.reason })
      }
      if (kind === 'defend' && analysis.status !== 'ready') setError(analysis.reason)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Stress run failed.')
      setAccountCheck({ state: 'failed', detail: 'Devnet check could not complete.' })
    } finally {
      setBusy(false)
    }
  }

  async function importWalletBalance() {
    if (!walletAddress) return
    setWalletLoading(true)
    setError('')
    try {
      const balance = await getSolBalance(walletAddress)
      if (balance < .1) throw new Error('This wallet has less than 0.1 SOL available on devnet.')
      setTreasurySol(Math.floor(balance * 1000) / 1000)
      invalidate()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet balance could not be read.')
    } finally {
      setWalletLoading(false)
    }
  }

  async function commit() {
    if (!result?.selected || !result.audit?.passed || busy) return
    setBusy(true)
    setError('')
    try {
      // The quote can expire while judges inspect the chart; re-read before opening the trade desk.
      const { price, rows } = await loadMarket()
      const fresh = analyzeHedgeLab({ spotUsd: price, treasurySol, expiryDays, maxPremiumUsd,
        maxDrawdownPct: maxDrawdownPct / 100, crashDropPct: crashDropPct / 100, series: rows })
      const prior = result.selected
      if (!fresh.selected || fresh.selected.strikeUsd !== prior.strikeUsd || fresh.selected.hedgeSol < prior.hedgeSol || !fresh.audit?.passed) {
        setResult(fresh)
        setAccountCheck({ state: 'failed', detail: 'Live maker terms changed. Review the new hedge before continuing.' })
        throw new Error('Maker quote changed. Refresh the hedge search before signing.')
      }
      const account = await verifyDevnet(fresh)
      setAccountCheck(account)
      if (account.state !== 'verified') throw new Error(account.detail)
      onCommit({ side: 'buy', kind: 'put', quantitySol: fresh.selected.hedgeSol,
        expiryDays, targetStrikeUsd: fresh.selected.strikeUsd, maxPremiumUsd,
        objective: `Protect ${fresh.selected.hedgeSol} SOL at $${fresh.selected.strikeUsd} in Mirror Lab` })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare devnet order.')
    } finally {
      setBusy(false)
    }
  }

  const attackValue = result ? result.crashPriceUsd * treasurySol : null
  const roundRed = result?.redTeam?.worstCrash
  const warning = selected && !selected.reserveBackedAtCrash
    ? `At this crash, contractual payout may need ${(liveCase?.requiresExtraLiquiditySol ?? 0).toFixed(4)} SOL beyond the quote reserve.`
    : result?.redTeam?.firstReserveBreach
      ? `At deeper prices, the put's SOL payout can exceed its quote reserve. Verify pooled liquidity before relying on settlement.`
      : ''

  return <div className="mirror-lab">
    <header className="mirror-header">
      <div className="mirror-brand"><div className="mirror-wordmark"><img src="/soleil-logo.png" alt="" /> soleil</div><span className="mirror-brand-divider" /><span className="mirror-product-name">MIRROR</span></div>
      <div className="mirror-header-right">
        <span className={`mirror-status ${makerLabel === 'LIVE' ? '' : 'offline'}`} title={makerStatus === 'live' ? 'Gateway configured' : 'Gateway is not configured'}><i /> MAKER {makerLabel}</span>
        <span className="mirror-status"><i /> SOLANA DEVNET</span>
        <button className="mirror-back" onClick={onBack}><ArrowLeft size={14} /> Trade desk</button>
      </div>
    </header>
    <div className="mirror-intro">
      <div><h1>Soleil <span>Mirror.</span></h1></div>
      <div className="mirror-intro-metrics"><div><small>LIVE SOL / USD</small><strong>{spot ? money(spot) : 'Loading…'}</strong></div><div><small>MAKER STRIKES</small><strong className={series.length ? 'live' : ''}>{series.length || '—'}</strong></div><div><small>COVERED</small><strong>{selected ? pct(selected.coverageFraction) : '—'}</strong></div></div>
    </div>
    <main className="mirror-grid">
      <section className="mirror-panel mirror-panel-left" aria-label="Treasury and attack controls">
        <div className="mirror-section-head"><div><small>01 / SETUP</small><h2>Treasury</h2></div><span className="chip">READ ONLY</span></div>
        <div className="mirror-twin-card"><span className="mirror-card-label">SOL exposure at live spot</span><strong>{spot ? money(spot * treasurySol) : '—'}</strong><p>{treasurySol} SOL modeled · no assets moved</p>
          {walletAddress
            ? <button className="mirror-wallet-import" onClick={() => void importWalletBalance()} disabled={walletLoading}>{walletLoading ? <LoaderCircle size={12} className="mirror-spin" /> : <Wallet size={12} />}Use {short(walletAddress)} SOL balance</button>
            : <span className="mirror-wallet-hint">Connect a wallet in Trade desk to import its devnet SOL balance.</span>}
        </div>
        <div className="mirror-fields">
          <div className="mirror-field"><label htmlFor="mirror-sol">Treasury SOL</label><input id="mirror-sol" type="number" min="0.1" step="0.1" value={treasurySol} onChange={(event) => { setTreasurySol(asNumber(event.target.value, .1)); invalidate() }} /></div>
          <div className="mirror-field"><label htmlFor="mirror-expiry">Expiry</label><select id="mirror-expiry" value={expiryDays} onChange={(event) => { setExpiryDays(Number(event.target.value)); invalidate() }}><option value={7}>7 days</option><option value={10}>10 days</option><option value={14}>14 days</option></select></div>
          <div className="mirror-field"><label htmlFor="mirror-budget">Max premium USD</label><input id="mirror-budget" type="number" min="0" step="1" value={maxPremiumUsd} onChange={(event) => { setMaxPremiumUsd(asNumber(event.target.value, 0)); invalidate() }} /></div>
          <div className="mirror-field"><label htmlFor="mirror-drawdown">Max loss</label><select id="mirror-drawdown" value={maxDrawdownPct} onChange={(event) => { setMaxDrawdownPct(Number(event.target.value)); invalidate() }}><option value={10}>10%</option><option value={20}>20%</option><option value={30}>30%</option><option value={40}>40%</option></select></div>
        </div>
        <div className="mirror-scenario-box"><div className="mirror-scenario-head"><span className="mirror-card-label">Downside scenario</span><strong>−{crashDropPct}%</strong></div><input type="range" aria-label="SOL price crash percentage" min="10" max="80" step="5" value={crashDropPct} onChange={(event) => { setCrashDropPct(Number(event.target.value)); invalidate() }} /><div className="mirror-scenario-scale"><span>−10%</span><span>−80%</span></div></div>
        <div className="mirror-actions"><button className="mirror-secondary" onClick={() => void run('attack')} disabled={busy}><Swords size={14} /> Stress test</button><button className="mirror-primary" onClick={() => void run('defend')} disabled={busy}>{busy ? <LoaderCircle size={14} className="mirror-spin" /> : <ShieldCheck size={14} />} Find hedge</button></div>
        {error && <div className="mirror-error" role="alert">{error}</div>}
      </section>
      <section className="mirror-panel mirror-panel-center" aria-label="Adversarial result and branching realities">
        <div className="mirror-toolbar"><div><span className="mirror-kicker"><Crosshair size={11} /> 02 / OUTCOMES</span><h2>Scenario</h2></div><div className="mirror-tabs"><button className={phase === 'attacked' ? 'active' : ''} onClick={() => phase !== 'idle' && setPhase('attacked')}>Stress</button><button className={phase === 'defended' ? 'active' : ''} onClick={() => result?.selected && setPhase('defended')}>Hedge</button></div></div>
        <RealityChart result={result} phase={phase} treasurySol={treasurySol} scenarioSpot={scenarioSpot} onScenarioSpot={setScenarioSpot} />
        <div className="mirror-rounds">
          <div className={`mirror-round red ${phase === 'idle' ? 'pending' : ''}`}><div className="mirror-round-head">STRESS TEST <Swords size={14} /></div><strong>{roundRed ? money(roundRed.expirySpotUsd) : result ? money(result.crashPriceUsd) : 'Not run'}</strong><p>{result ? `SOL value: ${money(roundRed?.unhedgedValueUsd ?? attackValue ?? 0)}` : 'See the treasury at the selected downside.'}</p></div>
          <div className={`mirror-round blue ${phase !== 'defended' ? 'pending' : ''}`}><div className="mirror-round-head">HEDGE SEARCH <ShieldCheck size={14} /></div><strong>{selected ? `$${selected.strikeUsd} put` : 'Not run'}</strong><p>{selected ? `${selected.hedgeSol} SOL · ${money(selected.premiumUsd)} premium` : 'Find a quote within the premium limit.'}</p></div>
          <div className={`mirror-round auditor ${phase !== 'defended' ? 'pending' : ''}`}><div className="mirror-round-head">VERIFICATION <Fingerprint size={14} /></div><strong>{phase === 'defended' ? result?.audit?.passed ? 'Passed' : 'Review needed' : 'Not run'}</strong><p>{phase === 'defended' ? accountCheck.state === 'verified' ? 'Market and quote accounts verified.' : accountCheck.detail : 'Checks price, quote, and devnet accounts.'}</p></div>
        </div>
        <div className="mirror-strip"><span>{selected ? `${pct(selected.coverageFraction)} of ${treasurySol} SOL covered by the selected quote.` : phase === 'attacked' ? 'Scenario ready. Search for a hedge.' : 'No order selected.'}</span><strong>{selected ? `${money(selected.lossReductionUsd)} improvement` : 'WALLET GATED'}</strong></div>
      </section>
      <aside className="mirror-panel mirror-panel-right" aria-label="Hedge audit and devnet commitment">
        <div className="mirror-section-head"><div><small>03 / REVIEW</small><h2>Hedge</h2></div><span className="chip">PUT ONLY</span></div>
        <div className="mirror-quote-card"><span className="mirror-card-label">{selected ? 'LIVE MAKER QUOTE' : 'AWAITING QUOTE'}</span><h3>{selected ? `Buy $${selected.strikeUsd} SOL put` : 'No hedge selected'}</h3><p>{selected ? `${selected.hedgeSol} SOL · ${expiryDays} day expiry · quote ${short(selected.quoteAddress)}` : 'A fresh, verified quote appears here after the hedge search.'}</p>
          <div className="mirror-pair"><span>Crash without hedge</span><strong>{selected ? money(selected.unhedgedCrashValueUsd) : '—'}</strong></div>
          <div className="mirror-pair"><span>Crash with put model</span><strong className="good">{selected ? money(selected.hedgedCrashValueUsd) : '—'}</strong></div>
          <div className="mirror-pair"><span>Modeled improvement</span><strong className="good">{selected ? money(selected.lossReductionUsd) : '—'}</strong></div>
          <div className="mirror-pair"><span>Quote coverage</span><strong>{selected ? `${pct(selected.coverageFraction)} · ${selected.hedgeSol} SOL` : '—'}</strong></div>
          <div className="mirror-pair"><span>Premium paid in SOL</span><strong>{selected ? `${selected.premiumSol.toFixed(5)} SOL` : '—'}</strong></div>
        </div>
        <div className="mirror-audit"><div className="mirror-mini-header">CHECKS <Search size={13} /></div>
          <div className="mirror-audit-line"><span>Quote / payoff math</span><strong className={result?.audit?.passed ? 'good' : ''}>{selected ? result?.audit?.passed ? 'PASS' : 'FAIL' : 'PENDING'}</strong></div>
          <div className="mirror-audit-line"><span>Devnet accounts</span><strong className={accountCheck.state === 'verified' ? 'good' : accountCheck.state === 'failed' ? 'bad' : ''}>{accountCheck.state.toUpperCase()}</strong></div>
          <div className="mirror-audit-line"><span>Quote freshness</span><strong className={quoteFresh ? 'good' : selected ? 'bad' : ''}>{selected ? quoteFresh ? 'LIVE' : 'EXPIRED' : 'PENDING'}</strong></div>
          <div className="mirror-audit-line"><span>Crash floor target</span><strong className={selected?.floorMet ? 'good' : selected ? 'bad' : ''}>{selected ? selected.floorMet ? 'MET + RESERVED' : 'NOT PROVEN' : 'PENDING'}</strong></div>
          {accountCheck.state !== 'unchecked' && <div className="mirror-live-check"><i /> {accountCheck.detail}</div>}
          {warning && <div className="mirror-warning"><CircleAlert size={14} />{warning}</div>}
          {result?.audit?.issues.map((issue) => <div key={issue} className="mirror-warning"><CircleAlert size={14} />{issue}</div>)}
        </div>
        <div className="mirror-commit"><button className="mirror-primary" onClick={() => void commit()} disabled={!readyToCommit || busy}>{busy ? <LoaderCircle size={14} className="mirror-spin" /> : <Play size={14} />} Continue to devnet order <ArrowRight size={14} /></button><p>{readyToCommit ? 'The trade desk refreshes this quote before wallet signing.' : selected ? accountCheck.state === 'failed' ? accountCheck.detail : quoteFresh ? 'Devnet account check required before continuing.' : 'Quote expired. Refresh the hedge search.' : 'A live quote and passed checks are required.'}</p><p>Model only. Your wallet approves every settlement.</p></div>
      </aside>
    </main>
  </div>
}
