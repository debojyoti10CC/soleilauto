const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function normalizeIntent(value, previous = {}) {
  const allowedSide = value?.side === 'sell' ? 'sell' : value?.side === 'buy' ? 'buy' : previous.side
  const allowedKind = value?.kind === 'call' ? 'call' : value?.kind === 'put' ? 'put' : previous.kind
  const expiry = number(value?.expiryDays) ?? previous.expiryDays
  return {
    side: allowedSide,
    kind: allowedKind,
    quantitySol: number(value?.quantitySol) ?? previous.quantitySol,
    expiryDays: [7, 10, 14].includes(expiry) ? expiry : undefined,
    targetStrikeUsd: number(value?.targetStrikeUsd) ?? previous.targetStrikeUsd,
    maxPremiumSol: number(value?.maxPremiumSol) ?? previous.maxPremiumSol,
    maxPremiumUsd: number(value?.maxPremiumUsd) ?? previous.maxPremiumUsd,
    objective: typeof value?.objective === 'string' && value.objective.trim() ? value.objective.trim().slice(0, 160) : previous.objective,
  }
}

export function parseLocally(message, previous = {}) {
  const text = String(message).toLowerCase()
  const value = {}
  if (/\b(protect|hedge|insurance|downside|put)\b/.test(text)) {
    value.kind = 'put'
    value.side = 'buy'
    value.objective = 'Protect SOL against a price drop'
  } else if (/\b(call|upside|rise)\b/.test(text)) {
    value.kind = 'call'
    value.side = 'buy'
    value.objective = 'Buy SOL upside exposure'
  }
  if (/\bsell|write|short\b/.test(text)) value.side = 'sell'
  if (/\bbuy\b/.test(text)) value.side = 'buy'
  const size = text.match(/\b(?:protect|cover|hedge|size|quantity|buy|sell)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*sol\b/)
    ?? [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*sol\b/g)].find((match) => !/(?:under|below|at most|max(?:imum)?|budget|spend)\s*(?:of\s*)?$/.test(text.slice(Math.max(0, (match.index ?? 0) - 22), match.index)))
  if (size) value.quantitySol = Number(size[1])
  const budget = text.match(/(?:under|below|at most|max(?:imum)?|budget|spend)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*sol\b/)
  if (budget) value.maxPremiumSol = Number(budget[1])
  const usdBudget = text.match(/(?:spend(?:ing)?|budget|at most|max(?:imum)?|for under)\s*(?:of\s*)?\$\s*(\d+(?:\.\d+)?)/)
  if (usdBudget) value.maxPremiumUsd = Number(usdBudget[1])
  if (/next week|one week|7\s*days?/.test(text)) value.expiryDays = 7
  if (/10\s*days?/.test(text)) value.expiryDays = 10
  if (/two weeks|fortnight|14\s*days?/.test(text)) value.expiryDays = 14
  const strike = text.match(/(?:strike|floor|below|above)\s*\$?\s*(\d+(?:\.\d+)?)/)
  if (strike) value.targetStrikeUsd = Number(strike[1])
  return normalizeIntent(value, previous)
}

export function missingFields(intent) {
  const missing = []
  if (!intent.kind) missing.push('whether you want a put or call')
  if (!intent.side) missing.push('whether to buy or sell')
  if (!intent.quantitySol) missing.push('quantity in SOL')
  if (!intent.expiryDays) missing.push('7, 10, or 14-day expiry')
  return missing
}

export function requestsPositionLifecycle(message) {
  return /\b(close|exit|cash out|liquidate|cancel)\b|\bsell\s+(?:my|existing)\b/i.test(String(message))
}
