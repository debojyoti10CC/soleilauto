import { describe, expect, it } from 'vitest'
import { chooseOrder, rankOrders } from './order'
import type { OptionSeries, QuoteTerms } from './domain'

const terms = (premiumLamportsPerSol: number, remainingSize = 1): QuoteTerms => ({
  quoteAddress: 'quote', maker: 'maker', nonce: 1, premiumLamportsPerSol,
  collateralLamportsPerSol: 1_000_000_000, expiresAt: Math.floor(Date.now() / 1000) + 120, remainingSize,
})
const row = (strike: number, premium: number, remainingSize = 1): OptionSeries => ({
  expiryDays: 7, expiryLabel: 'Next week', expiryAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
  strike, call: { bid: 2, ask: 2.2, iv: 55, bidQuote: terms(100_000_000), askQuote: terms(110_000_000) },
  put: { bid: premium - 0.2, ask: premium, iv: 56, bidQuote: terms(40_000_000), askQuote: terms(Math.round(premium * 10_000_000), remainingSize) },
})

describe('live quote selection', () => {
  it('chooses a target strike within budget', () => {
    const choice = chooseOrder({ kind: 'put', side: 'buy', quantitySol: 0.1, expiryDays: 7, targetStrikeUsd: 115, maxPremiumSol: 0.01 }, [row(110, 0.8), row(115, 0.5)], 118)
    expect(choice?.series.strike).toBe(115)
  })
  it('rejects quotes that cannot fill the size', () => {
    const choice = chooseOrder({ kind: 'put', side: 'buy', quantitySol: 0.5, expiryDays: 7 }, [row(115, 1, 0.1)], 118)
    expect(choice).toBeNull()
  })
  it('rejects quotes above the stated SOL cap', () => {
    const choice = chooseOrder({ kind: 'put', side: 'buy', quantitySol: 0.5, expiryDays: 7, maxPremiumSol: 0.001 }, [row(115, 1)], 118)
    expect(choice).toBeNull()
  })
  it('rejects quotes above the stated USD cap at live spot', () => {
    const choice = chooseOrder({ kind: 'put', side: 'buy', quantitySol: 0.5, expiryDays: 7, maxPremiumUsd: 0.1 }, [row(115, 1)], 118)
    expect(choice).toBeNull()
  })
  it('ranks executable alternatives by target distance', () => {
    const ranked = rankOrders({ kind: 'put', side: 'buy', quantitySol: 0.1, expiryDays: 7, targetStrikeUsd: 115 }, [row(105, 0.5), row(115, 0.9), row(110, 0.7)], 118)
    expect(ranked.map((choice) => choice.series.strike)).toEqual([115, 110, 105])
  })
})
