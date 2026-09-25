import type { OptionKind, OptionSeries, QuoteTerms, TradeSide } from './domain'
import { quoteTotalLamports } from './settlement'

export interface OrderIntent {
  side?: TradeSide
  kind?: OptionKind
  quantitySol?: number
  expiryDays?: number
  targetStrikeUsd?: number
  maxPremiumSol?: number
  maxPremiumUsd?: number
  objective?: string
}

export interface OrderChoice {
  series: OptionSeries
  kind: OptionKind
  side: TradeSide
  quantitySol: number
  priceUsd: number
  terms: QuoteTerms
  premiumLamports: number
  collateralLamports: number
}

export function rankOrders(intent: OrderIntent, rows: OptionSeries[], spot: number): OrderChoice[] {
  if (!intent.kind || !intent.side || !intent.quantitySol || intent.quantitySol < 0.1 || !intent.expiryDays || !Number.isFinite(spot) || spot <= 0) return []
  const choices = rows.flatMap((series) => {
    if (series.expiryDays !== intent.expiryDays || !series.expiryAt || series.expiryAt <= Date.now() / 1000) return []
    const quote = series[intent.kind!]
    const terms = intent.side === 'buy' ? quote.askQuote : quote.bidQuote
    const priceUsd = intent.side === 'buy' ? quote.ask : quote.bid
    if (!terms || terms.expiresAt <= Date.now() / 1000 + 15 || terms.remainingSize < intent.quantitySol! || !Number.isFinite(priceUsd) || priceUsd <= 0) return []
    const premiumLamports = quoteTotalLamports(terms.premiumLamportsPerSol, intent.quantitySol!)
    if (intent.side === 'buy' && intent.maxPremiumSol && premiumLamports > intent.maxPremiumSol * 1_000_000_000) return []
    if (intent.side === 'buy' && intent.maxPremiumUsd && premiumLamports / 1_000_000_000 * spot > intent.maxPremiumUsd) return []
    return [{ series, kind: intent.kind!, side: intent.side!, quantitySol: intent.quantitySol!, priceUsd, terms, premiumLamports, collateralLamports: intent.side === 'sell' ? quoteTotalLamports(terms.collateralLamportsPerSol, intent.quantitySol!) : 0 }]
  })
  const target = intent.targetStrikeUsd ?? (intent.kind === 'put' ? spot * 0.97 : spot * 1.03)
  choices.sort((a, b) => Math.abs(a.series.strike - target) - Math.abs(b.series.strike - target) || a.premiumLamports - b.premiumLamports)
  return choices
}

export function chooseOrder(intent: OrderIntent, rows: OptionSeries[], spot: number): OrderChoice | null {
  return rankOrders(intent, rows, spot)[0] ?? null
}
