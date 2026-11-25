const lotSize = 10

export const scenarios = {
  zero: { feeRate: 0, marketTicks: 0, penetration: 1, reward: 2 },
  base: { feeRate: 0.0001, marketTicks: 1, penetration: 1, reward: 2 },
  stress: { feeRate: 0.0004, marketTicks: 2, penetration: 1, reward: 2 },
  deeperFill: { feeRate: 0.0001, marketTicks: 1, penetration: 2, reward: 2 },
  targetFirst: { feeRate: 0.0001, marketTicks: 1, penetration: 1, reward: 2, targetFirst: true },
  onePriceClose: { feeRate: 0.0001, marketTicks: 1, penetration: 1, reward: 2, onePriceClose: true },
  oneR: { feeRate: 0.0001, marketTicks: 1, penetration: 1, reward: 1 },
  threeR: { feeRate: 0.0001, marketTicks: 1, penetration: 1, reward: 3 },
}

function entryFill(bar, order, penetration) {
  const { direction, kind, entry } = order
  if (kind === 'market') return { price: bar.open, atOpen: true }
  const open = direction * (bar.open - entry)
  if (kind === 'limit') {
    if (open <= -penetration) return { price: bar.open, atOpen: true }
    const low = direction > 0 ? bar.low : bar.high
    if (direction * (low - entry) <= -penetration) return { price: entry, atOpen: false }
    return
  }
  if (open >= 0) return { price: bar.open, atOpen: true }
  const high = direction > 0 ? bar.high : bar.low
  if (direction * (high - entry) >= 0) return { price: entry, atOpen: false }
}

function createPosition(bar, index, order, fill, spec) {
  const { direction, stop, entry, kind } = order
  const targetBasis = kind === 'limit' ? entry : fill.price
  const plannedRisk = direction * (targetBasis - stop)
  const risk = direction * (fill.price - stop) * lotSize
  if (plannedRisk <= 0 || risk <= 0) throw new Error('Invalid protective stop on ' + bar.date)
  const target = order.target === undefined
    ? targetBasis + direction * Math.ceil(spec.reward * plannedRisk)
    : order.target
  if (target !== null && direction * (target - fill.price) < Math.max(1, (order.minimumReward ?? 0) * risk / lotSize)) {
    return undefined
  }
  return {
    order, bar, index, fill, target, risk,
    openingSlippage: kind === 'limit' ? 0 : lotSize * spec.marketTicks,
  }
}

function protectionExit(bar, index, position, { penetration, targetFirst }) {
  const { order: { direction, stop, kind }, target, fill } = position
  const enteredIntrabar = index === position.index && !fill.atOpen
  if (position.deferred) return { reason: position.deferred, price: bar.open }
  if (!enteredIntrabar) {
    if (direction * (bar.open - stop) <= 0) return { reason: 'stop', price: bar.open }
    if (target !== null && direction * (bar.open - target) >= penetration) return { reason: 'target', price: target }
  }
  const adverse = direction > 0 ? bar.low : bar.high
  const favorable = direction > 0 ? bar.high : bar.low
  const targetReached = target !== null && direction * (favorable - target) >= penetration
  if (targetFirst && targetReached) return { reason: 'target', price: target }
  if (direction * (adverse - stop) <= 0) return { reason: 'stop', price: stop }
  // A move to the target also crosses a resting stop entry, while a limit entry can occur after that move.
  if (targetReached && (!enteredIntrabar || kind === 'stop' || direction * (bar.close - target) >= penetration)) {
    return { reason: 'target', price: target }
  }
}

function finishTrade(bars, exitBar, position, exit, spec) {
  const { order, fill, target, risk, openingSlippage } = position
  const { direction, stop, kind, entry, reference } = order
  const gross = direction * (exit.price - fill.price) * lotSize
  const fee = (fill.price + exit.price) * lotSize * spec.feeRate
  const marketLegs = Number(kind !== 'limit') + Number(exit.reason !== 'target')
  const slippage = openingSlippage + (exit.reason === 'target' ? 0 : lotSize * spec.marketTicks)
  const net = gross - fee - slippage
  return {
    contract: position.bar.contract, direction: direction > 0 ? 'long' : 'short',
    origin: bars[order.origin].date, originDay: bars[order.origin].tradeDate,
    signal: bars[order.index].date, signalDay: bars[order.index].tradeDate, reference,
    orderType: kind, plannedEntry: entry, entry: position.bar.date, entryDay: position.bar.tradeDate,
    entryPrice: fill.price, entryAtOpen: fill.atOpen, stop, target,
    exit: exitBar.date, exitDay: exitBar.tradeDate, exitPrice: exit.price, reason: exit.reason,
    gross, fee, marketLegs, slippage, net, netR: net / risk,
  }
}

export function simulate(bars, signals, { from, through, spec, blocked = new Set(), exitAtNextOpen }) {
  const byIndex = new Map()
  for (const order of signals) {
    const { tradeDate } = bars[order.index]
    if (tradeDate < from || tradeDate > through || blocked.has(tradeDate)) continue
    // An ambiguous tie is resolved deterministically using the first signal.
    if (!byIndex.has(order.index)) byIndex.set(order.index, order)
  }

  let pending
  let position
  let placed = 0
  let realized = 0
  let peak = 0
  let maxDrawdown = 0
  let day
  const daily = []
  const trades = []
  for (const [index, bar] of bars.entries()) {
    if (bar.tradeDate < from) continue
    if (bar.tradeDate > through) break
    if (day?.date !== bar.tradeDate) {
      day = { date: bar.tradeDate, trades: 0, net: 0, gross: 0, equity: realized }
      daily.push(day)
    }
    const dayEnd = bar.date.endsWith(' 15:00')
    const locked = bar.high === bar.low
    if (position && position.bar.contract !== bar.contract) {
      throw new Error('A locked position crossed a contract roll on ' + bar.tradeDate)
    }

    if (pending) {
      const signalBar = bars[pending.index]
      if (dayEnd || signalBar.tradeDate !== bar.tradeDate || signalBar.contract !== bar.contract ||
          pending.direction * (bar.open - pending.stop) <= 0) {
        pending = undefined
      } else {
        const fill = !locked && entryFill(bar, pending, spec.penetration)
        if (fill) {
          position = createPosition(bar, index, pending, fill, spec)
          pending = undefined
        } else if (index - pending.index >= pending.life) {
          pending = undefined
        }
      }
    }

    if (position) {
      const protection = protectionExit(bar, index, position, spec)
      const scheduled = dayEnd ? { reason: 'day_end', price: bar.close } : undefined
      const exit = locked ? (spec.onePriceClose && scheduled) : (protection ?? scheduled)
      if (exit) {
        const trade = finishTrade(bars, bar, position, exit, spec)
        trades.push(trade)
        realized += trade.net
        day.trades++
        day.net += trade.net
        day.gross += trade.gross
        position = undefined
      } else if (locked && !position.deferred && (protection?.reason === 'stop' || dayEnd)) {
        position.deferred = protection?.reason === 'stop' ? 'stop' : 'day_end'
      } else if (!position.deferred && exitAtNextOpen?.(index, position.order)) {
        position.deferred = 'ema_close'
      }
    }

    if (!dayEnd && !position && !pending && byIndex.has(index)) {
      pending = byIndex.get(index)
      placed++
    }
    const unrealized = position
      ? ((bar.close - position.fill.price) * position.order.direction - position.fill.price * spec.feeRate) * lotSize
        - position.openingSlippage
      : 0
    day.equity = realized + unrealized
    peak = Math.max(peak, day.equity)
    maxDrawdown = Math.max(maxDrawdown, peak - day.equity)
  }
  if (position || pending) throw new Error('Unresolved order or position at the sample end')
  const signalCount = signals.filter((order) => {
    const { tradeDate } = bars[order.index]
    return tradeDate >= from && tradeDate <= through && !blocked.has(tradeDate)
  }).length
  return { trades, daily, maxDrawdown, signalCount, placed }
}

export function stats(trades, { maxDrawdown, signalCount, placed } = {}) {
  let gain = 0
  let loss = 0
  let gross = 0
  let fees = 0
  let slippage = 0
  let wins = 0
  let netR = 0
  let marketLegs = 0
  const exits = {}
  const count = trades.length
  for (const trade of trades) {
    if (trade.net > 0) {
      wins++
      gain += trade.net
    } else loss -= trade.net
    gross += trade.gross
    fees += trade.fee
    slippage += trade.slippage
    netR += trade.netR
    marketLegs += trade.marketLegs
    exits[trade.reason] = (exits[trade.reason] ?? 0) + 1
  }
  const net = gain - loss
  return {
    count, wins, winRate: count ? wins / count : null, net, gross, fees, slippage,
    mean: count ? net / count : null, meanR: count ? netR / count : null,
    profitFactor: loss ? gain / loss : null,
    breakEvenMarketTicks: marketLegs ? (gross - fees) / (marketLegs * lotSize) : null,
    maxDrawdown, signalCount, placed, exits,
  }
}

export function csv(rows, columns) {
  const line = (row) => columns.map((column) => {
    const value = row[column]
    if (typeof value === 'number' && !Number.isInteger(value)) return value.toFixed(6)
    return value ?? ''
  }).join(',')
  return [columns.join(','), ...rows.map(line)].join('\n') + '\n'
}

export function tradesCsv(ledger) {
  return csv(ledger, [
    'section', 'model', 'contract', 'direction', 'origin', 'originDay', 'signal', 'signalDay', 'reference',
    'orderType', 'plannedEntry', 'entry', 'entryDay', 'entryPrice', 'entryAtOpen', 'stop', 'target',
    'exit', 'exitDay', 'exitPrice', 'reason', 'gross', 'fee', 'marketLegs', 'slippage', 'net', 'netR', 'qualityFlags',
  ])
}

function randomIntegerGenerator(seed) {
  return (size) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor(size * seed / 2 ** 32)
  }
}

export function meanInterval(daily, comparisons) {
  const blockSize = 5
  const draws = 12000
  if (daily.filter((day) => day.trades > 0).length < 20) return null
  const sampleCount = daily.length
  const blocks = Math.ceil(sampleCount / blockSize)
  const tailSize = sampleCount - (blocks - 1) * blockSize
  function sums(size) {
    return daily.map((_, start) => {
      let trades = 0
      let net = 0
      for (let offset = 0; offset < size; offset++) {
        const day = daily[(start + offset) % sampleCount]
        trades += day.trades
        net += day.net
      }
      return { trades, net }
    })
  }

  const full = sums(blockSize)
  const tail = sums(tailSize)
  const randomIndex = randomIntegerGenerator(20261117)
  const means = []
  for (let draw = 0; draw < draws; draw++) {
    let trades = 0
    let net = 0
    for (let block = 1; block < blocks; block++) {
      const sample = full[randomIndex(sampleCount)]
      trades += sample.trades
      net += sample.net
    }
    const remainder = tail[randomIndex(sampleCount)]
    trades += remainder.trades
    net += remainder.net
    if (trades) means.push(net / trades)
  }
  means.sort((first, second) => first - second)
  const quantile = (probability) => means[Math.floor((means.length - 1) * probability)]
  const adjustedTail = 0.025 / comparisons
  return {
    low: quantile(0.025), high: quantile(0.975),
    adjustedLow: quantile(adjustedTail), adjustedHigh: quantile(1 - adjustedTail),
    draws: means.length, blockSize,
  }
}
