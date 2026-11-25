export type ProtectionKind = 'target' | 'stop'
export type ProtectionPrices = { target?: number; stop?: number }

export function protectionError(prices: ProtectionPrices, reference: number, direction = 1, precision = 3) {
  for (const value of [prices.target, prices.stop]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 ||
      Math.abs(value * 10 ** precision - Math.round(value * 10 ** precision)) > 1e-6)) {
      return `价格需为正数，最多 ${precision} 位小数。`
    }
  }
  if (prices.target !== undefined && (prices.target - reference) * direction <= 0) {
    return direction === 1 ? '止盈价应高于参考价。' : '空单止盈价应低于参考价。'
  }
  if (prices.stop !== undefined && (prices.stop - reference) * direction >= 0) {
    return direction === 1 ? '止损价应低于参考价。' : '空单止损价应高于参考价。'
  }
  return ''
}

export function protectionChangeError(prices: ProtectionPrices, previous: ProtectionPrices, reference: number, direction = 1, precision = 3) {
  return protectionError({
    target: prices.target === previous.target ? undefined : prices.target,
    stop: prices.stop === previous.stop ? undefined : prices.stop,
  }, reference, direction, precision)
}

export function matchMarketProtection(
  bar: { open: number; high: number; low: number; close: number; volume: number },
  { stop, target }: ProtectionPrices,
  direction: 1 | -1,
  precision: number,
  { enteredIntrabar = false, triggered, useSideQuote = false }: {
    enteredIntrabar?: boolean; triggered?: ProtectionKind; useSideQuote?: boolean
  } = {},
) {
  if (!bar.volume) return
  const hitsStop = (price: number) => stop !== undefined && direction * (price - stop) <= 0
  const hitsTarget = (price: number) => target !== undefined && direction * (price - target) >= 0
  const ticks = 10 ** precision
  const fill = (kind: ProtectionKind, referencePrice: number) => {
    const triggerDirection = kind === 'target' ? direction : -direction
    const offset = useSideQuote ? direction : triggerDirection
    const reference = Math.max(bar.low, Math.min(referencePrice, bar.high))
    const price = Math.max(bar.low, Math.min(bar.high, (Math.round(reference * ticks) - offset) / ticks))
    return { kind, price, reference }
  }

  if (triggered) return fill(triggered, bar.open)
  if (!enteredIntrabar) {
    if (hitsStop(bar.open)) return fill('stop', bar.open)
    if (hitsTarget(bar.open)) return fill('target', bar.open)
  }
  if (stop !== undefined && hitsStop(direction === 1 ? bar.low : bar.high)) return fill('stop', stop)
  if (target !== undefined && hitsTarget(direction === 1 ? bar.high : bar.low)
      && (!enteredIntrabar || hitsTarget(bar.close))) return fill('target', target)
}
