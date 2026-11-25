export type PriceEntry = { price: number; type: 'limit' | 'stop' }
export const entryLabels = { limit: '限价挂单', stop: '突破挂单' }

export function validPriceEntry(entry: PriceEntry, precision: number) {
  if (!entry || (entry.type !== 'limit' && entry.type !== 'stop') || !Number.isFinite(entry.price) || entry.price <= 0) return false
  const ticks = entry.price * 10 ** precision
  const rounded = Math.round(ticks)
  return Number.isSafeInteger(rounded) && rounded > 0 && Math.abs(ticks - rounded) < 1e-6
}

export function priceEntry(price: number, reference: number, direction: number): PriceEntry {
  return { price, type: (price - reference) * direction > 0 ? 'stop' : 'limit' }
}

/** A submitted order starts matching on the next bar. Gaps execute at the open. */
export function matchPriceEntry(bar: { open: number; high: number; low: number; volume: number }, entry: PriceEntry, direction: number) {
  if (!bar.volume) return undefined
  const triggerDirection = entry.type === 'stop' ? direction : -direction
  if ((bar.open - entry.price) * triggerDirection >= 0) return { price: bar.open, intrabar: false }
  const extreme = triggerDirection > 0 ? bar.high : bar.low
  if ((extreme - entry.price) * triggerDirection >= 0) return { price: entry.price, intrabar: true }
}
