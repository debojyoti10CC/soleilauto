import { describe, expect, it } from 'vitest'
import type { OptionSeries, QuoteTerms } from './domain'
import { analyzeHedgeLab, auditHedgeCandidate, evaluateHedgeAtExpiry } from './lab-engine'

const NOW = 1_800_000_000

function row(strike: number, premiumSolPerUnit: number, options: {
  capacity?: number; expiresAt?: number; collateralSolPerUnit?: number; quoteAddress?: string; expiryDays?: number
} = {}): OptionSeries {
  const terms: QuoteTerms = {
    quoteAddress: options.quoteAddress ?? `quote-${strike}`,
    maker: 'devnet-maker', nonce: strike,
    premiumLamportsPerSol: Math.round(premiumSolPerUnit * 1_000_000_000),
    collateralLamportsPerSol: Math.round((options.collateralSolPerUnit ?? 1) * 1_000_000_000),
    expiresAt: options.expiresAt ?? NOW + 120,
    remainingSize: options.capacity ?? 1,
  }
  return {
    strike, expiryDays: options.expiryDays ?? 7, expiryLabel: 'Seven days', expiryAt: NOW + 7 * 86_400,
    call: { bid: 1, ask: 2, iv: 55 },
    put: { bid: 1, ask: 999, iv: 55, askQuote: terms },
  }
}

const input = (series: OptionSeries[], extra: Record<string, unknown> = {}) => ({
  spotUsd: 100, treasurySol: 1, expiryDays: 7,
  maxPremiumUsd: 10, maxDrawdownPct: 0.2, series,
  crashDropPct: 0.5, nowUnix: NOW, ...extra,
})

describe('adversarial treasury hedge lab', () => {
  it('ignores indicative, expired, and undersized rows', () => {
    const indicative = row(95, 0.01)
    indicative.put.askQuote = undefined
    const result = analyzeHedgeLab(input([
      indicative,
      row(90, 0.01, { expiresAt: NOW + 15 }),
      row(85, 0.01, { capacity: 0.09 }),
    ]))
    expect(result.status).toBe('no-live-quotes')
    expect(result.selected).toBeNull()
    expect(result.coverageFraction).toBe(0)
  })

  it('uses signed quote lamports for a treasury-funded premium and shows partial coverage', () => {
    const result = analyzeHedgeLab(input([row(90, 0.04, { capacity: 0.1 })], {
      treasurySol: 10, maxDrawdownPct: 0.2,
    }))
    expect(result.status).toBe('ready')
    expect(result.selected?.hedgeSol).toBe(0.1)
    expect(result.coverageFraction).toBeCloseTo(0.01)
    expect(result.selected?.premiumLamports).toBe(4_000_000)
    expect(result.selected?.premiumUsd).toBeCloseTo(0.4)
    expect(result.selected?.floorMet).toBe(false)
    // The UI quote ask is deliberately 999; it cannot override signed SOL premium terms.
    expect(result.selected?.series.put.ask).toBe(999)
  })

  it('selects a floor-compliant put before a cheaper but insufficient strike', () => {
    const result = analyzeHedgeLab(input([
      row(80, 0.01), row(90, 0.05),
    ]))
    expect(result.status).toBe('ready')
    expect(result.selected?.strikeUsd).toBe(90)
    expect(result.selected?.floorMet).toBe(true)
    expect(result.selected?.hedgedCrashValueUsd).toBeCloseTo(87.5)
    expect(result.candidates.find((item) => item.strikeUsd === 80)?.floorMet).toBe(false)
    expect(result.audit?.passed).toBe(true)
  })

  it('enforces USD budget against on-chain SOL premium', () => {
    const result = analyzeHedgeLab(input([row(90, 0.05)], { maxPremiumUsd: 4.99 }))
    expect(result.status).toBe('over-budget')
    expect(result.selected).toBeNull()
  })

  it('refuses an explicit hedge size larger than the available maker quote', () => {
    const result = analyzeHedgeLab(input([row(90, 0.04, { capacity: 0.1 })], {
      treasurySol: 10, hedgeSol: 1,
    }))
    expect(result.status).toBe('no-live-quotes')
    expect(result.selected).toBeNull()
  })

  it('red-teams deep-crash settlement liquidity and rally opportunity cost', () => {
    const result = analyzeHedgeLab(input([row(90, 0.05)]))
    const selected = result.selected!
    const deepCrash = evaluateHedgeAtExpiry(selected, 10)
    const rally = evaluateHedgeAtExpiry(selected, 200)
    expect(selected.collateralBoundaryUsd).toBe(45)
    expect(deepCrash.optionPayoutSol).toBe(8)
    expect(deepCrash.requiresExtraLiquiditySol).toBe(7)
    expect(deepCrash.reserveBacked).toBe(false)
    expect(rally.optionPayoutSol).toBe(0)
    expect(rally.improvementUsd).toBeCloseTo(-10)
    expect(result.redTeam?.firstReserveBreach).not.toBeNull()
    expect(result.redTeam?.biggestMissedUpside.improvementUsd).toBeLessThan(0)
    expect(result.audit?.passed).toBe(true)
    expect(result.audit?.warnings.some((item) => item.includes('total market liquidity'))).toBe(true)
  })

  it('does not claim the drawdown floor when the crash needs liquidity beyond quote reserves', () => {
    const result = analyzeHedgeLab(input([row(90, 0.05)], {
      crashDropPct: 0.9, maxDrawdownPct: 0.2,
    }))
    expect(result.selected?.hedgedCrashValueUsd).toBeGreaterThan(result.targetFloorUsd)
    expect(result.selected?.reserveBackedAtCrash).toBe(false)
    expect(result.selected?.floorMet).toBe(false)
    expect(result.audit?.passed).toBe(true)
    expect(result.audit?.warnings.some((item) => item.includes('additional market liquidity'))).toBe(true)
  })

  it('auditor rejects fabricated protection and mutated quote terms', () => {
    const source = input([row(90, 0.05)])
    const result = analyzeHedgeLab(source)
    const candidate = result.selected!
    expect(auditHedgeCandidate(source, { ...candidate, hedgedCrashValueUsd: 500 }).passed).toBe(false)
    expect(auditHedgeCandidate(source, { ...candidate, terms: { ...candidate.terms, premiumLamportsPerSol: 1 } }).passed).toBe(false)
    expect(auditHedgeCandidate(source, { ...candidate, floorMet: false }).passed).toBe(false)
  })

  it('returns the same stress cases and chart for the same inputs', () => {
    const source = input([row(90, 0.05)])
    expect(analyzeHedgeLab(source)).toEqual(analyzeHedgeLab(source))
  })
})
