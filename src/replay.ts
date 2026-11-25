import { matchMarketProtection, protectionChangeError, protectionError } from './protection.ts'
import type { ProtectionKind, ProtectionPrices } from './protection.ts'
import { matchPriceEntry, priceEntry, validPriceEntry } from './entryOrder.ts'
import type { PriceEntry } from './entryOrder.ts'

export type Bar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type MarketData = { symbol: string; source: string; bars: Bar[] }
export type Settings = { capital: number; commission: number; minimum: number }
export type Side = 'buy' | 'sell'
export type ManualBuyTiming = 'close' | 'open'
export type Order = { side: Side; quantity: number; date: string; takeProfitRate?: number; stopLossRate?: number; protection?: ProtectionPrices; entry?: PriceEntry }
export type Execution = Order & {
  fillDate: string
  price: number
  fee: number
  realized: number
  reversal?: { markDate: string; signalDate: string; netReturn?: number }
}
export type StrategyRules = {
  quantity: number
  entry: 'close' | 'open'
  target: 'net' | 'price'
  stopLossRate?: number
}
type Signal = StrategyRules & { markDate: string }
type ReadySignal = Signal & { signalDate: string }
export type Strategy =
  | (Signal & { phase: 'counting'; bullish: 0 | 1 })
  | (ReadySignal & { phase: 'entry' })
  | (ReadySignal & {
    phase: 'holding'; targetPrice: number; entryPrice: number; entryDate: string
    stopPrice?: number; stopTriggered?: boolean
  })
type ProtectionOrder = { date: string; rate: number; price: number; triggered?: boolean; fixed?: boolean }
type ReplayState = {
  cursor: number
  cash: number
  shares: number
  cost: number
  pending: Order | null
  message: string
  peak: number
  maxDrawdown: number
  strategy?: Strategy | null
  strategyRules?: StrategyRules
  manualTakeProfitRate?: number
  manualStopLossRate?: number
  manualBuyTiming?: ManualBuyTiming
  manualTakeProfit?: ProtectionOrder | null
  manualStopLoss?: ProtectionOrder | null
}

type Checkpoint = ReplayState & { barDate: string; tradeCount: number }

export type Session = ReplayState & {
  start: number
  settings: Settings
  trades: Execution[]
  checkpoints?: Checkpoint[]
}

export const defaultSettings = { capital: 100000, commission: 0.005, minimum: 0 }
export const targetRates = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const
export const lot = 100
export const defaultManualTakeProfitRate = 1
export const defaultStopLossRate = 1

export function validExitRate(rate: number) {
  return Number.isFinite(rate) && rate >= 1 && rate <= 10
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function validSettings(settings: Settings) {
  const { capital, commission, minimum } = settings
  return Number.isFinite(capital) && capital >= 1 && capital <= 1e9 &&
    Number.isFinite(commission) && commission >= 0 && commission <= 10 &&
    Number.isFinite(minimum) && minimum >= 0 && minimum <= 10000
}

export function startSession(start: number, settings: Settings): Session {
  const capital = money(settings.capital)
  return {
    start, cursor: start, settings: { ...settings, capital }, cash: capital,
    shares: 0, cost: 0, pending: null, trades: [], message: '',
    peak: capital, maxDrawdown: 0,
  }
}

export function equity(session: Session, close: number) {
  return money(session.cash + session.shares * close)
}

export function orderError(session: Session, side: Side, quantity: number, lastBar: boolean) {
  if (lastBar) return '已到行情末尾，没有下一根 K 线。'
  if (session.strategy) return '当前仓位由逆转策略管理。'
  if (session.pending) return '已有一笔待成交委托。'
  if (!Number.isSafeInteger(quantity) || quantity < lot || quantity % lot) {
    return '请输入 100 的整数倍份额。'
  }
  if (side === 'sell' && quantity > session.shares) return '卖出数量超过当前持仓。'
  if (side === 'buy' && session.cash <= session.settings.minimum) return '可用现金不足。'
  return ''
}

export function manualOrderError(
  session: Session, side: Side, quantity: number, rate: number, timing: ManualBuyTiming, lastBar: boolean,
  stopLossRate = defaultStopLossRate, fixed?: { prices: ProtectionPrices; reference: number },
) {
  return orderError(session, side, quantity, lastBar && (side === 'sell' || timing === 'open')) ||
    (side === 'buy' && (session.manualTakeProfit?.triggered || session.manualStopLoss?.triggered) ? '保护单已触发，等待卖出成交。' : '') ||
    (side !== 'buy' ? '' : fixed ? protectionError(fixed.prices, fixed.reference)
      : !validExitRate(rate) ? '止盈率请输入 1% 到 10%。'
      : !validExitRate(stopLossRate) ? '止损率请输入 1% 到 10%。' : '')
}

export function cancelManualProtection(session: Session, kind: ProtectionKind): Session {
  const field = kind === 'stop' ? 'manualStopLoss' : 'manualTakeProfit'
  if (!session[field] || session[field].triggered) return session
  return { ...session, [field]: null, message: kind === 'stop' ? '已撤销手动止损。' : '已撤销手动止盈。' }
}

function feeFor(notional: number, settings: Settings) {
  return money(Math.max(notional * settings.commission / 100, settings.minimum))
}

function limitLocked(bar: Bar, previous: Bar, side: Side) {
  const limit = Math.round(previous.close * (side === 'buy' ? 1100 : 900)) / 1000
  return bar.high === bar.low && (side === 'buy' ? bar.open >= limit : bar.open <= limit)
}

function fill(next: Session, order: Order, bar: Bar, previous: Bar, price: number, signal?: ReadySignal) {
  const { side, quantity } = order
  const locked = limitLocked(bar, previous, side)
  if (locked || !bar.volume) {
    next.message = `${bar.date} ${locked ? '一字涨跌停' : '无成交量'}，委托未成交。`
    return false
  }
  const notional = money(quantity * price)
  const fee = feeFor(notional, next.settings)
  if (side === 'buy' && money(notional + fee) > next.cash) {
    next.message = `${bar.date} 可用现金不足，买入委托未成交。`
    return false
  }
  const soldCost = side === 'sell' ? money(next.cost * quantity / next.shares) : 0
  const realized = side === 'sell' ? money(notional - fee - soldCost) : 0
  if (side === 'buy') {
    next.cash = money(next.cash - notional - fee)
    next.shares += quantity
    next.cost = money(next.cost + notional + fee)
  } else {
    next.cash = money(next.cash + notional - fee)
    next.shares -= quantity
    next.cost = money(next.cost - soldCost)
  }
  const reversal = signal ? {
    markDate: signal.markDate,
    signalDate: signal.signalDate,
    netReturn: soldCost > 0 ? realized / soldCost : undefined,
  } : undefined
  next.message = `${bar.date} 以 ¥${price.toFixed(3)} 成交 ${quantity.toLocaleString('zh-CN')} 份。`
  next.trades = [...next.trades, { ...order, fillDate: bar.date, price, fee, realized, reversal }]
  return true
}

function netTargetPrice(cost: number, quantity: number, settings: Settings, rate: number) {
  const proceeds = Math.ceil(cost * (100 + rate) - 1e-7) / 100
  const commissionRate = settings.commission / 100
  let ticks = Math.ceil(Math.max(proceeds + settings.minimum, proceeds / (1 - commissionRate)) / quantity * 1000)
  const netAt = (tick: number) => {
    const notional = money(tick * quantity / 1000)
    return money(notional - feeFor(notional, settings))
  }
  // Commission rounds to cents, so check the neighboring tick against the actual net proceeds.
  while (netAt(ticks - 1) >= proceeds) ticks--
  while (netAt(ticks) < proceeds) ticks++
  return ticks / 1000
}

type ExitKind = 'stop' | 'target'

function protectiveExit(bar: Bar, target?: number, stop?: number, stopTriggered = false, resting = true):
  { kind: ExitKind; price: number } | null {
  if (!bar.volume) return null
  if (stopTriggered) return { kind: 'stop', price: bar.open }
  if (resting) {
    if (stop !== undefined && bar.open <= stop) return { kind: 'stop', price: bar.open }
    if (target !== undefined && bar.open >= target) return { kind: 'target', price: bar.open }
  }
  // A daily bar does not show the order of its high and low. Resolve both intraday touches at the stop.
  if (stop !== undefined && bar.low <= stop) return { kind: 'stop', price: Math.min(stop, bar.high) }
  if (target !== undefined && bar.high >= target) return { kind: 'target', price: Math.max(target, bar.low) }
  return null
}

export function takeProfitResults(trades: Execution[], settings: Settings, bars: Bar[], cursor: number) {
  const indices = new Map(bars.map((bar, index) => [bar.date, index]))
  return trades.flatMap((entry) => {
    if (entry.side !== 'buy' || !entry.reversal) return []
    const index = indices.get(entry.fillDate)
    if (index === undefined || index > cursor) return []
    const cost = money(entry.quantity * entry.price + entry.fee)
    const stopPrice = entry.stopLossRate === undefined ? undefined
      : netTargetPrice(cost, entry.quantity, settings, -entry.stopLossRate)
    const alternatives = targetRates.map((rate) => ({
      rate,
      price: netTargetPrice(cost, entry.quantity, settings, rate),
      exit: null as { date: string; kind: ExitKind; price: number; profit: number; days: number; netReturn: number } | null,
    }))
    let openCount = alternatives.length
    let stopTriggered = false
    // A close entry cannot sell against a high printed before the entry.
    const firstExitIndex = entry.fillDate === entry.reversal.signalDate ? index + 1 : index
    for (let i = firstExitIndex; i <= cursor && openCount > 0; i++) {
      const bar = bars[i]
      const locked = i > 0 && limitLocked(bar, bars[i - 1], 'sell')
      for (const alternative of alternatives) {
        if (alternative.exit) continue
        const result = protectiveExit(bar, alternative.price, stopPrice, stopTriggered, i > index)
        if (!result) continue
        if (locked) {
          if (result.kind === 'stop') stopTriggered = true
          continue
        }
        const { kind, price } = result
        const notional = money(price * entry.quantity)
        const profit = money(notional - feeFor(notional, settings) - cost)
        alternative.exit = { date: bar.date, kind, price, profit, days: i - index, netReturn: profit / cost }
        openCount--
      }
    }
    return [{ entry, stopPrice, alternatives }]
  })
}

export function markReversal(session: Session, bar: Bar, rules: StrategyRules, lastBar: boolean): Session {
  const error = orderError(session, 'buy', rules.quantity, lastBar) ||
    (rules.stopLossRate !== undefined && !validExitRate(rules.stopLossRate) ? '止损率请输入 1% 到 10%。' : '')
  if (error || session.shares) return {
    ...session,
    message: error || '请先平掉手动持仓，再标记逆转。',
  }
  return {
    ...session, message: '', strategyRules: rules,
    strategy: { ...rules, markDate: bar.date, phase: 'counting', bullish: bar.close > bar.open ? 1 : 0 },
  }
}

function enterStrategy(next: Session, signal: ReadySignal, bar: Bar, previous: Bar, price: number) {
  const order: Order = { side: 'buy', quantity: signal.quantity, date: signal.signalDate, stopLossRate: signal.stopLossRate }
  next.strategy = fill(next, order, bar, previous, price, signal) ? {
    ...signal, phase: 'holding', entryDate: bar.date, entryPrice: price,
    targetPrice: signal.target === 'price' ? Math.ceil(Math.round(price * 1000) * 101 / 100) / 1000
      : netTargetPrice(next.cost, signal.quantity, next.settings, 1),
    stopPrice: signal.stopLossRate === undefined ? undefined
      : netTargetPrice(next.cost, signal.quantity, next.settings, -signal.stopLossRate),
  } : null
}

function updateStrategy(next: Session, bar: Bar, previous: Bar) {
  const strategy = next.strategy
  if (!strategy) return
  if (strategy.phase === 'counting') {
    if (bar.close <= bar.open) return
    if (strategy.bullish === 0) {
      next.strategy = { ...strategy, bullish: 1 }
      return
    }
    const signal = { ...strategy, signalDate: bar.date }
    if (strategy.entry === 'open') {
      next.strategy = { ...signal, phase: 'entry' }
    } else {
      enterStrategy(next, signal, bar, previous, bar.close)
    }
    return
  }
  if (strategy.phase === 'entry') enterStrategy(next, strategy, bar, previous, bar.open)

  const position = next.strategy
  if (position?.phase !== 'holding') return
  const exit = protectiveExit(bar, position.targetPrice, position.stopPrice, position.stopTriggered, strategy.phase === 'holding')
  if (!exit) return
  const stopLossRate = exit.kind === 'stop' ? position.stopLossRate : undefined
  const order: Order = { side: 'sell', quantity: position.quantity, date: position.entryDate, stopLossRate }
  if (fill(next, order, bar, previous, exit.price, position)) {
    next.strategy = null
    if (exit.kind === 'stop') next.message = `${bar.date} 策略止损成交 · ¥${exit.price.toFixed(3)}。`
  } else if (exit.kind === 'stop') {
    next.strategy = { ...position, stopTriggered: true }
  }
}

function fillManualOrder(next: Session, order: Order, bar: Bar, previous: Bar, price: number) {
  const oldTarget = next.manualTakeProfit
  const oldStop = next.manualStopLoss
  if (!fill(next, order, bar, previous, price)) return
  const priorRate = next.manualTakeProfit?.rate
  const rate = order.side === 'buy' ? order.takeProfitRate ?? priorRate : priorRate
  next.manualTakeProfit = next.shares > 0 && rate !== undefined && validExitRate(rate)
    ? { date: bar.date, rate, price: netTargetPrice(next.cost, next.shares, next.settings, rate) }
    : null
  const priorStop = next.manualStopLoss
  const stopRate = order.side === 'buy' ? order.stopLossRate ?? priorStop?.rate : priorStop?.rate
  next.manualStopLoss = next.shares > 0 && stopRate !== undefined && validExitRate(stopRate)
    ? {
      date: bar.date, rate: stopRate, price: netTargetPrice(next.cost, next.shares, next.settings, -stopRate),
    }
    : null
  if (next.shares > 0) {
    if (order.side === 'buy' && order.protection) {
      applyProtection(next, bar.date, order.protection)
    } else if (order.side === 'sell') {
      if (oldTarget?.fixed || oldTarget?.triggered) next.manualTakeProfit = oldTarget
      if (oldStop?.fixed || oldStop?.triggered) next.manualStopLoss = oldStop
    }
  }
}

function applyProtection(session: Session, date: string, prices: ProtectionPrices, keepUnchanged = false) {
  const make = (price: number | undefined, direction: number): ProtectionOrder | null => price === undefined ? null : {
    date, price, fixed: true,
    rate: direction * ((price * session.shares - feeFor(price * session.shares, session.settings)) / session.cost - 1) * 100,
  }
  if (!keepUnchanged || prices.target !== session.manualTakeProfit?.price) session.manualTakeProfit = make(prices.target, 1)
  if (!keepUnchanged || prices.stop !== session.manualStopLoss?.price) session.manualStopLoss = make(prices.stop, -1)
}

export function amendManualProtection(session: Session, bars: Bar[], prices: ProtectionPrices): Session {
  if (session.strategy || session.manualStopLoss?.triggered || session.manualTakeProfit?.triggered) return session
  const bar = bars[session.cursor]
  const pending = session.pending?.side === 'buy' ? session.pending : undefined
  const error = pending ? protectionError(prices, pending.entry?.price ?? bar.close)
    : protectionChangeError(prices, { target: session.manualTakeProfit?.price, stop: session.manualStopLoss?.price }, bar.close)
  if (error) return { ...session, message: error }
  if (pending) return {
    ...session, pending: { ...pending, protection: prices }, message: '委托保护价已更新。',
  }
  if (!session.shares) return session
  const next = { ...session, message: '持仓保护价已更新，从下一根 K 线生效。' }
  applyProtection(next, bar.date, prices, true)
  return next
}

function updateManualOrders(next: Session, order: Order | null, bar: Bar, previous: Bar) {
  const matched = order?.entry ? matchPriceEntry(bar, order.entry, 1) : { price: bar.open, intrabar: false }
  if (order?.entry && (!matched || limitLocked(bar, previous, 'buy') || !bar.volume)) {
    next.pending = order
  } else if (order && matched) fillManualOrder(next, order, bar, previous, matched.price)

  const target = next.manualTakeProfit
  const stop = next.manualStopLoss
  if (!target && !stop) return
  const enteredIntrabar = !!order?.entry && !!matched?.intrabar && next.trades.at(-1)?.fillDate === bar.date
  const triggered = stop?.triggered ? 'stop' : target?.triggered ? 'target' : undefined
  const exit = matchMarketProtection(bar, { target: target?.price, stop: stop?.price }, 1, 3, { enteredIntrabar, triggered })
  if (!exit) return
  const trigger = exit.kind === 'stop' ? stop : target
  if (!trigger) return
  const sell: Order = {
    side: 'sell', quantity: next.shares, date: trigger.date,
    takeProfitRate: exit.kind === 'target' ? trigger.rate : undefined,
    stopLossRate: exit.kind === 'stop' ? trigger.rate : undefined,
  }
  if (fill(next, sell, bar, previous, exit.price)) {
    next.manualTakeProfit = null
    next.manualStopLoss = null
    next.message = `${bar.date} 手动${exit.kind === 'stop' ? '止损' : '止盈'}成交 · ¥${exit.price.toFixed(3)} · ${sell.quantity.toLocaleString('zh-CN')} 份。`
  } else {
    next.manualTakeProfit = exit.kind === 'target' ? { ...trigger, triggered: true } : null
    next.manualStopLoss = exit.kind === 'stop' ? { ...trigger, triggered: true } : null
    next.message = `${bar.date} ${exit.kind === 'stop' ? '止损' : '止盈'}已触发，等待可成交开盘。`
  }
}

function markToMarket(next: Session, close: number) {
  const value = equity(next, close)
  next.peak = Math.max(next.peak, value)
  next.maxDrawdown = Math.max(next.maxDrawdown, (next.peak - value) / next.peak)
}

export function submitManualOrder(
  session: Session, bars: Bar[], side: Side, quantity: number, rate: number, timing: ManualBuyTiming,
  stopLossRate = defaultStopLossRate,
  protection?: ProtectionPrices,
  entry?: PriceEntry,
): Session {
  const error = manualOrderError(session, side, quantity, rate, entry ? 'open' : timing,
    session.cursor === bars.length - 1, stopLossRate,
    protection && { prices: protection, reference: entry?.price ?? bars[session.cursor].close }) ||
    (entry && (side !== 'buy' || session.shares > 0) ? '画线挂单用于空仓买入，请先平仓。' : '') ||
    (entry && !validPriceEntry(entry, 3) ? '挂单价需为正数，最多 3 位小数。' : '')
  if (error) return { ...session, message: error }

  const bar = bars[session.cursor]
  const next = { ...session, message: '' }
  const order: Order = { side, quantity, date: bar.date }
  order.entry = entry
  if (side === 'buy') {
    next.manualBuyTiming = timing
    if (protection === undefined) {
      next.manualTakeProfitRate = order.takeProfitRate = rate
      next.manualStopLossRate = order.stopLossRate = stopLossRate
    }
    order.protection = protection
    if (timing === 'close' && !entry) {
      fillManualOrder(next, order, bar, bars[session.cursor - 1] ?? bar, bar.close)
      markToMarket(next, bar.close)
      return next
    }
  }
  next.pending = order
  return next
}

export function amendManualEntry(session: Session, bars: Bar[], price: number | undefined): Session {
  if (!session.pending?.entry) return session
  if (price === undefined) return { ...session, pending: null, message: '已撤销价格挂单。' }
  const entry = priceEntry(price, bars[session.cursor].close, 1)
  const error = !validPriceEntry(entry, 3) ? '挂单价需为正数，最多 3 位小数。'
    : session.pending.protection && protectionError(session.pending.protection, price)
  return error ? { ...session, message: error }
    : { ...session, pending: { ...session.pending, entry }, message: '挂单价已更新，从下一根 K 线开始触发。' }
}

export function advance(session: Session, bars: Bar[]): Session {
  const cursor = session.cursor + 1
  const bar = bars[cursor]
  if (!bar) return session

  const previous = bars[session.cursor]
  const { start, settings, trades, checkpoints, ...state } = session
  const checkpoint = { ...state, barDate: previous.date, tradeCount: trades.length }
  const next: Session = {
    ...state, start, settings, trades, cursor, pending: null,
    checkpoints: [...(checkpoints ?? []), checkpoint],
  }
  updateManualOrders(next, session.pending, bar, previous)
  if (cursor === bars.length - 1 && next.pending?.entry) {
    next.pending = null
    next.message = '行情已结束，未触发的价格挂单已撤销。'
  }
  updateStrategy(next, bar, previous)
  markToMarket(next, bar.close)
  return next
}

export function canRewind(session: Session) {
  return (session.checkpoints?.length ?? 0) > 0 && session.cursor > session.start
}

export function rewind(session: Session): Session {
  const checkpoint = session.checkpoints?.at(-1)
  if (!checkpoint || !canRewind(session)) return session

  const { barDate: _barDate, tradeCount, ...state } = checkpoint
  return {
    ...state,
    start: session.start,
    settings: session.settings,
    trades: session.trades.slice(0, tradeCount),
    checkpoints: session.checkpoints?.slice(0, -1),
  }
}

export function resolveDate(bars: Bar[], date: string) {
  return bars.findIndex((bar) => bar.date >= date)
}
