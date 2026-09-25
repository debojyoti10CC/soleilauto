import type { OptionSeries, QuoteTerms } from './domain'

/** A treasury-funded protective put, evaluated against live on-chain maker asks only. */
export interface HedgeLabInput {
  spotUsd: number
  treasurySol: number
  expiryDays: number
  maxPremiumUsd: number
  /** Fraction of today's treasury USD value that may be lost at the crash test, e.g. .30. */
  maxDrawdownPct: number
  series: OptionSeries[]
  /** Defaults per quote to min(treasurySol, that quote's remainingSize). */
  hedgeSol?: number
  /** Crash test depth, e.g. .50 tests a 50% fall in SOL. Defaults to .50. */
  crashDropPct?: number
  /** Pass explicitly for reproducible quote-expiry checks. Defaults to the current Unix second. */
  nowUnix?: number
}

export interface HedgeCandidate {
  series: OptionSeries
  terms: QuoteTerms
  spotUsd: number
  strikeUsd: number
  expiryAt: number
  treasurySol: number
  hedgeSol: number
  coverageFraction: number
  quoteAddress: string
  quoteExpiresAt: number
  premiumLamports: number
  premiumSol: number
  /** SOL premium marked at the live spot supplied to the lab; actual payment is in SOL. */
  premiumUsd: number
  reservedCollateralSol: number
  /** At a lower expiry spot the put needs more SOL than this quote reserves. Extra market liquidity is unverified. */
  collateralBoundaryUsd: number
  crashPriceUsd: number
  unhedgedCrashValueUsd: number
  hedgedCrashValueUsd: number
  lossReductionUsd: number
  lossReductionPerPremium: number
  targetFloorUsd: number
  floorMet: boolean
  reserveBackedAtCrash: boolean
}

export interface HedgeStressCase {
  label: string
  expirySpotUsd: number
  unhedgedValueUsd: number
  hedgedValueUsd: number
  /** A long put settles in SOL: intrinsic USD value / oracle USD price. */
  optionPayoutSol: number
  optionPayoutUsd: number
  improvementUsd: number
  drawdownPct: number
  requiresExtraLiquiditySol: number
  reserveBacked: boolean
}

export interface HedgeAudit {
  passed: boolean
  issues: string[]
  warnings: string[]
  /** This is a model/evidence audit, not a claim that the Solana transaction will settle. */
  quoteAuthenticity: 'unverified-by-model'
}

export interface HedgeCurvePoint {
  expirySpotUsd: number
  unhedgedValueUsd: number
  hedgedValueUsd: number
  requiresExtraLiquiditySol: number
}

export interface HedgeLabResult {
  status: 'ready' | 'no-live-quotes' | 'over-budget' | 'invalid-input'
  reason: string
  candidates: HedgeCandidate[]
  selected: HedgeCandidate | null
  coverageFraction: number
  targetFloorUsd: number
  crashPriceUsd: number
  redTeam: {
    cases: HedgeStressCase[]
    worstCrash: HedgeStressCase
    biggestMissedUpside: HedgeStressCase
    firstReserveBreach: HedgeStressCase | null
  } | null
  audit: HedgeAudit | null
  curve: HedgeCurvePoint[]
}

const LAMPORTS = 1_000_000_000n
const MIN_ORDER_SOL = 0.1
const EPSILON = 1e-6

const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
const quantityUnits = (quantitySol: number) => BigInt(Math.floor(quantitySol * 1_000_000_000))
const proportional = (perSol: number, units: bigint) => Number(BigInt(perSol) * units / LAMPORTS)
const cents = (usd: number) => Math.max(1, Math.round(usd * 100))

function settlementPayoutSol(strikeUsd: number, expirySpotUsd: number, hedgeSol: number): number {
  const strike = cents(strikeUsd)
  const observed = cents(expirySpotUsd)
  const intrinsic = Math.max(0, strike - observed)
  // Mirrors soleil-settlement: intrinsic_cents * quantity_units / oracle_price_cents.
  const payoutLamports = BigInt(intrinsic) * quantityUnits(hedgeSol) / BigInt(observed)
  return Number(payoutLamports) / 1_000_000_000
}

/** Compare holding SOL with buying the quoted put using SOL from that same treasury. */
export function evaluateHedgeAtExpiry(candidate: HedgeCandidate, expirySpotUsd: number): HedgeStressCase {
  if (!Number.isFinite(expirySpotUsd) || expirySpotUsd <= 0) throw new Error('Expiry spot must be positive.')
  const optionPayoutSol = settlementPayoutSol(candidate.strikeUsd, expirySpotUsd, candidate.hedgeSol)
  const unhedgedValueUsd = candidate.treasurySol * expirySpotUsd
  const hedgedValueUsd = (candidate.treasurySol - candidate.premiumSol + optionPayoutSol) * expirySpotUsd
  const requiresExtraLiquiditySol = Math.max(0, optionPayoutSol - candidate.reservedCollateralSol)
  const initialValueUsd = candidate.treasurySol * candidate.spotUsd
  const drawdownPct = initialValueUsd > 0 ? Math.max(0, (initialValueUsd - hedgedValueUsd) / initialValueUsd) : 0
  return {
    label: '', expirySpotUsd, unhedgedValueUsd, hedgedValueUsd,
    optionPayoutSol, optionPayoutUsd: optionPayoutSol * expirySpotUsd,
    improvementUsd: hedgedValueUsd - unhedgedValueUsd,
    drawdownPct, requiresExtraLiquiditySol,
    reserveBacked: requiresExtraLiquiditySol <= EPSILON,
  }
}

function validAsk(series: OptionSeries, expiryDays: number, nowUnix: number): series is OptionSeries & { expiryAt: number; put: { askQuote: QuoteTerms } } {
  const terms = series.put?.askQuote
  return series.expiryDays === expiryDays
    && Number.isFinite(series.strike) && series.strike > 0
    && typeof series.expiryAt === 'number' && Number.isSafeInteger(series.expiryAt) && series.expiryAt > nowUnix
    && Boolean(terms && typeof terms.quoteAddress === 'string' && terms.quoteAddress.length > 0
      && typeof terms.maker === 'string' && terms.maker.length > 0
      && Number.isSafeInteger(terms.nonce)
      && Number.isSafeInteger(terms.premiumLamportsPerSol) && terms.premiumLamportsPerSol > 0
      && Number.isSafeInteger(terms.collateralLamportsPerSol) && terms.collateralLamportsPerSol > 0
      && Number.isFinite(terms.remainingSize) && terms.remainingSize >= MIN_ORDER_SOL
      && Number.isSafeInteger(terms.expiresAt) && terms.expiresAt > nowUnix + 15)
}

function empty(status: HedgeLabResult['status'], reason: string, input: HedgeLabInput, crashPriceUsd: number): HedgeLabResult {
  return {
    status, reason, candidates: [], selected: null, coverageFraction: 0,
    targetFloorUsd: input.treasurySol * input.spotUsd * (1 - input.maxDrawdownPct),
    crashPriceUsd, redTeam: null, audit: null, curve: [],
  }
}

/**
 * Blue chooses a live put ask. Red searches deterministic expiry spots for failure and liquidity gaps.
 * No indicative chain rows qualify. This does not submit a transaction or verify an on-chain quote account.
 */
export function analyzeHedgeLab(input: HedgeLabInput): HedgeLabResult {
  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000)
  const crashDropPct = input.crashDropPct ?? 0.5
  const crashPriceUsd = input.spotUsd * (1 - crashDropPct)
  if (!Number.isFinite(input.spotUsd) || input.spotUsd <= 0
    || !Number.isFinite(input.treasurySol) || input.treasurySol < MIN_ORDER_SOL
    || !Number.isFinite(input.expiryDays) || input.expiryDays <= 0
    || !Number.isFinite(input.maxPremiumUsd) || input.maxPremiumUsd < 0
    || !Number.isFinite(input.maxDrawdownPct) || input.maxDrawdownPct < 0 || input.maxDrawdownPct > 1
    || !Number.isFinite(crashDropPct) || crashDropPct <= 0 || crashDropPct >= 1
    || !Number.isSafeInteger(nowUnix) || !Array.isArray(input.series)
    || (input.hedgeSol !== undefined && (!Number.isFinite(input.hedgeSol) || input.hedgeSol < MIN_ORDER_SOL || input.hedgeSol > input.treasurySol))) {
    return empty('invalid-input', 'Enter a positive SOL spot, at least 0.1 SOL treasury, valid risk limits, and a supported hedge size.', input, crashPriceUsd)
  }

  const targetFloorUsd = input.treasurySol * input.spotUsd * (1 - input.maxDrawdownPct)
  const available: HedgeCandidate[] = []
  for (const series of input.series) {
    if (!validAsk(series, input.expiryDays, nowUnix)) continue
    const terms = series.put.askQuote
    const requestedSize = input.hedgeSol ?? Math.min(input.treasurySol, terms.remainingSize)
    const hedgeSol = Math.floor(requestedSize * 1_000_000_000) / 1_000_000_000
    if (hedgeSol < MIN_ORDER_SOL || hedgeSol > terms.remainingSize || hedgeSol > input.treasurySol) continue
    const units = quantityUnits(hedgeSol)
    const premiumLamports = proportional(terms.premiumLamportsPerSol, units)
    if (premiumLamports <= 0 || premiumLamports >= input.treasurySol * 1_000_000_000) continue
    const premiumSol = premiumLamports / 1_000_000_000
    const reservedCollateralSol = proportional(terms.collateralLamportsPerSol, units) / 1_000_000_000
    const candidate: HedgeCandidate = {
      series, terms, spotUsd: input.spotUsd,
      strikeUsd: series.strike, expiryAt: series.expiryAt,
      treasurySol: input.treasurySol, hedgeSol,
      coverageFraction: hedgeSol / input.treasurySol,
      quoteAddress: terms.quoteAddress, quoteExpiresAt: terms.expiresAt,
      premiumLamports, premiumSol, premiumUsd: premiumSol * input.spotUsd,
      reservedCollateralSol,
      collateralBoundaryUsd: series.strike / (1 + reservedCollateralSol / hedgeSol),
      crashPriceUsd, unhedgedCrashValueUsd: 0, hedgedCrashValueUsd: 0,
      lossReductionUsd: 0, lossReductionPerPremium: 0,
      targetFloorUsd, floorMet: false, reserveBackedAtCrash: false,
    }
    const crash = evaluateHedgeAtExpiry(candidate, crashPriceUsd)
    candidate.unhedgedCrashValueUsd = crash.unhedgedValueUsd
    candidate.hedgedCrashValueUsd = crash.hedgedValueUsd
    candidate.lossReductionUsd = crash.improvementUsd
    candidate.lossReductionPerPremium = crash.improvementUsd / candidate.premiumUsd
    candidate.reserveBackedAtCrash = crash.reserveBacked
    candidate.floorMet = crash.hedgedValueUsd + EPSILON >= targetFloorUsd && crash.reserveBacked
    available.push(candidate)
  }

  if (!available.length) return empty('no-live-quotes', 'No unexpired, size-matched on-chain maker put asks are available for this expiry.', input, crashPriceUsd)
  const candidates = available.filter((candidate) => candidate.premiumUsd <= input.maxPremiumUsd + EPSILON)
  if (!candidates.length) return empty('over-budget', 'Live put asks exist, but their on-chain SOL premiums exceed the stated USD budget.', input, crashPriceUsd)

  candidates.sort((a, b) => Number(b.floorMet) - Number(a.floorMet)
    || b.lossReductionPerPremium - a.lossReductionPerPremium
    || b.hedgeSol - a.hedgeSol
    || a.premiumUsd - b.premiumUsd
    || b.strikeUsd - a.strikeUsd)
  const selected = candidates[0]

  const spotFractions = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
  const spots = [...new Set([...spotFractions.map((factor) => input.spotUsd * factor), crashPriceUsd, selected.collateralBoundaryUsd * 0.99])]
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b)
  const cases = spots.map((price) => {
    const risk = evaluateHedgeAtExpiry(selected, price)
    const pct = Math.round((price / input.spotUsd - 1) * 100)
    return { ...risk, label: pct < 0 ? `${Math.abs(pct)}% crash` : pct > 0 ? `${pct}% rally` : 'Flat' }
  })
  const worstCrash = cases.reduce((worst, item) => item.hedgedValueUsd < worst.hedgedValueUsd ? item : worst)
  const biggestMissedUpside = cases.reduce((worst, item) => item.improvementUsd < worst.improvementUsd ? item : worst)
  const firstReserveBreach = [...cases].reverse().find((item) => !item.reserveBacked) ?? null
  const curveSpots = [...new Set(Array.from({ length: 39 }, (_, index) => input.spotUsd * (0.1 + index * 0.05))
    .concat([input.spotUsd, selected.strikeUsd, crashPriceUsd, selected.collateralBoundaryUsd]))]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  const curve = curveSpots.map((price) => {
    const risk = evaluateHedgeAtExpiry(selected, price)
    return {
      expirySpotUsd: price,
      unhedgedValueUsd: risk.unhedgedValueUsd,
      hedgedValueUsd: risk.hedgedValueUsd,
      requiresExtraLiquiditySol: risk.requiresExtraLiquiditySol,
    }
  })
  const audit = auditHedgeCandidate(input, selected)
  return {
    status: 'ready',
    reason: selected.floorMet
      ? 'Cheapest-per-dollar crash protection among live quotes that meets the requested floor with the quoted reserve.'
      : 'No eligible quote proves the requested floor at the crash test; showing the best live risk reduction per premium.',
    candidates, selected, coverageFraction: selected.coverageFraction, targetFloorUsd, crashPriceUsd,
    redTeam: { cases, worstCrash, biggestMissedUpside, firstReserveBreach }, audit, curve,
  }
}

/** Recompute claims from the source quote and program payout formula without trusting candidate metrics. */
export function auditHedgeCandidate(input: HedgeLabInput, candidate: HedgeCandidate): HedgeAudit {
  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000)
  const issues: string[] = []
  const warnings: string[] = []
  const row = input.series.find((item) => item.strike === candidate.strikeUsd
    && item.expiryAt === candidate.expiryAt
    && item.put.askQuote?.quoteAddress === candidate.quoteAddress)
  if (!row || !validAsk(row, input.expiryDays, nowUnix)) {
    issues.push('No matching live executable put ask exists in the supplied chain.')
    return { passed: false, issues, warnings, quoteAuthenticity: 'unverified-by-model' }
  }
  if (!Number.isFinite(candidate.hedgeSol) || candidate.hedgeSol < MIN_ORDER_SOL
    || !Number.isSafeInteger(Math.floor(candidate.hedgeSol * 1_000_000_000))) {
    issues.push('Hedge quantity cannot be represented as a SOL contract size.')
    return { passed: false, issues, warnings, quoteAuthenticity: 'unverified-by-model' }
  }
  if (candidate.series.strike !== row.strike || candidate.series.expiryAt !== row.expiryAt
    || candidate.series.put.askQuote?.quoteAddress !== row.put.askQuote.quoteAddress) {
    issues.push('Selected contract row differs from the live quote source.')
  }
  const source = row.put.askQuote
  if (candidate.terms.maker !== source.maker || candidate.terms.nonce !== source.nonce
    || candidate.terms.expiresAt !== source.expiresAt
    || candidate.terms.premiumLamportsPerSol !== source.premiumLamportsPerSol
    || candidate.terms.collateralLamportsPerSol !== source.collateralLamportsPerSol
    || candidate.terms.remainingSize !== source.remainingSize
    || candidate.quoteExpiresAt !== source.expiresAt) issues.push('Quote terms were changed after retrieval.')
  if (candidate.hedgeSol < MIN_ORDER_SOL || candidate.hedgeSol > source.remainingSize
    || candidate.hedgeSol > input.treasurySol) issues.push('Hedge size exceeds live quote capacity or treasury holdings.')
  if (!close(candidate.spotUsd, input.spotUsd)
    || !close(candidate.treasurySol, input.treasurySol)
    || !close(candidate.coverageFraction, candidate.hedgeSol / input.treasurySol)) issues.push('Treasury coverage claim does not match input.')

  const sizeUnits = quantityUnits(candidate.hedgeSol)
  const independentlyComputedPremium = Number(BigInt(source.premiumLamportsPerSol) * sizeUnits / LAMPORTS)
  const premiumSol = independentlyComputedPremium / 1_000_000_000
  const premiumUsd = premiumSol * input.spotUsd
  const reserveSol = Number(BigInt(source.collateralLamportsPerSol) * sizeUnits / LAMPORTS) / 1_000_000_000
  if (candidate.premiumLamports !== independentlyComputedPremium
    || !close(candidate.premiumSol, premiumSol)
    || !close(candidate.premiumUsd, premiumUsd)
    || !close(candidate.reservedCollateralSol, reserveSol)) issues.push('Premium or reserve claim differs from signed quote arithmetic.')
  if (premiumUsd > input.maxPremiumUsd + EPSILON || premiumSol >= input.treasurySol) issues.push('Premium exceeds budget or available treasury SOL.')

  const crashPriceUsd = input.spotUsd * (1 - (input.crashDropPct ?? 0.5))
  const priceCents = cents(crashPriceUsd)
  const intrinsicCents = Math.max(0, cents(row.strike) - priceCents)
  const payoutSol = Number(BigInt(intrinsicCents) * sizeUnits / BigInt(priceCents)) / 1_000_000_000
  const unhedged = input.treasurySol * crashPriceUsd
  const hedged = (input.treasurySol - premiumSol + payoutSol) * crashPriceUsd
  const improvement = hedged - unhedged
  const floor = input.treasurySol * input.spotUsd * (1 - input.maxDrawdownPct)
  const backed = payoutSol <= reserveSol + EPSILON
  const floorMet = hedged + EPSILON >= floor && backed
  if (!close(candidate.crashPriceUsd, crashPriceUsd)
    || !close(candidate.unhedgedCrashValueUsd, unhedged)
    || !close(candidate.hedgedCrashValueUsd, hedged)
    || !close(candidate.lossReductionUsd, improvement)
    || !close(candidate.lossReductionPerPremium, improvement / premiumUsd)
    || !close(candidate.targetFloorUsd, floor)
    || candidate.floorMet !== floorMet
    || candidate.reserveBackedAtCrash !== backed
    || !close(candidate.collateralBoundaryUsd, row.strike / (1 + reserveSol / candidate.hedgeSol))) {
    issues.push('Hedge outcome, risk floor, or collateral boundary failed independent recomputation.')
  }
  if (!backed) warnings.push('Crash payoff exceeds this quote’s reserved SOL; additional market liquidity must be verified before claiming settlement coverage.')
  warnings.push('Model cannot authenticate quote accounts, oracle observations, or total market liquidity; verify these on devnet before signing.')
  return { passed: issues.length === 0, issues, warnings, quoteAuthenticity: 'unverified-by-model' }
}
