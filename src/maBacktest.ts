import { ictRetest, ictRetestWindow, ictSetups } from './ict.ts'
import type { IctBar, IctFill, IctSetup } from './ict.ts'

export type MaPeriod = '5m' | '1d'
export type MaBar = IctBar & {
  tradeDate: string
  contract: string
  rollFrom?: string
  rollExitOpen?: number
}

export const maWindow = { from: '2025-11-17', through: '2026-11-16' }
export const maBaseCosts = { feeRate: 0.0001, marketExitTicks: 1 }
export const maLotSize = 10
const dailyHoldLimit = 10

export type MaExitReason = 'stop' | 'target' | 'day_end' | 'time' | 'roll' | 'sample_end'
type MaExit = { price: number; reason: MaExitReason; timing: 'open' | 'intrabar' | 'close' }
export type MaCancelReason = 'expired' | 'invalidated' | 'day_end' | 'roll' | 'sample_end'
export type MaSkipReason = 'holding' | 'pending' | 'day_end' | 'sample_end' | 'same_bar'

export type MaPosition = {
  setup: IctSetup
  fill: IctFill
  index: number
  entryBar: MaBar
  direction: 1 | -1
  deferredExit?: MaExitReason
}

export type MaTrade = ReturnType<typeof tradeFromExit>

type Operation =
  | { kind: 'roll'; from: string; contract: string }
  | { kind: 'signal'; setup: IctSetup; skipped?: MaSkipReason }
  | { kind: 'order' | 'entry_wait'; setup: IctSetup }
  | { kind: 'cancel'; setup: IctSetup; reason: MaCancelReason }
  | { kind: 'entry'; setup: IctSetup; fill: IctFill }
  | { kind: 'exit_wait'; setup: IctSetup; reason: MaExitReason }
  | { kind: 'exit'; trade: MaTrade }
export type MaAction = Operation & { index: number }

export type MaFrame = {
  pending?: IctSetup
  position?: MaPosition
  realized: number
  equity: number
  maxDrawdown: number
  closed: number
  wins: number
}

type MaTrace = { actions: MaAction[]; frames: MaFrame[] }
type MaOptions = {
  intraday: boolean
  feeRate: number
  marketExitTicks: number
  start?: string
  trace?: MaTrace
}

export function parseMaMarket(text: string, period: MaPeriod | '1m'): MaBar[] {
  const [header, ...lines] = text.trimEnd().split(/\r?\n/)
  const fields = header.split(',')
  let previous: string | undefined
  return lines.map((line) => {
    const values = line.split(',')
    const row = Object.fromEntries(fields.map((field, index) => [field, values[index]]))
    const { trade_date: tradeDate, contract } = row
    const date = period === '1d' ? tradeDate : row.time
    const open = Number(row.open)
    const high = Number(row.high)
    const low = Number(row.low)
    const close = Number(row.close)
    const volume = Number(row.volume)
    const rollExitOpen = row.roll_exit_open ? Number(row.roll_exit_open) : undefined
    if (values.length !== fields.length || !/^MA\d{3}$/.test(contract) || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) ||
        (period !== '1d' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)) ||
        ![open, high, low, close, volume].every(Number.isSafeInteger) ||
        low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) ||
        (period === '1m' ? !row.volume?.trim() || volume < 0 : volume <= 0) ||
        (row.roll_from && (rollExitOpen === undefined || !Number.isSafeInteger(rollExitOpen) || rollExitOpen <= 0)) ||
        (previous && date <= previous)) {
      throw new Error('Invalid MA ' + period + ' row at ' + date)
    }
    previous = date
    const bar = { date, tradeDate, contract, segment: contract, open, high, low, close, volume }
    if (period === '1d') return { ...bar, rollFrom: row.roll_from, rollExitOpen }

    const time = date.slice(11)
    const session = time >= '21:00' ? 'night' : time <= '10:15' ? 'morning-1' : time <= '11:30' ? 'morning-2' : 'afternoon'
    return { ...bar, tradingDay: tradeDate, session: tradeDate + ' ' + session }
  })
}

export function withMaRolls(minutes: MaBar[], daily: MaBar[]) {
  const byDay = new Map(daily.filter(({ rollFrom }) => rollFrom).map((bar) => [bar.tradeDate, bar]))
  return minutes.map((bar) => {
    const roll = byDay.get(bar.tradeDate)
    return roll ? { ...bar, rollFrom: roll.rollFrom, rollExitOpen: roll.rollExitOpen } : bar
  })
}

type MaProtectionExit = { price: number; reason: 'stop' | 'target'; timing: 'open' | 'intrabar' }

export function maProtectionExit(
  bar: MaBar, direction: 1 | -1, { stop, target }: { stop?: number; target?: number }, enteredIntrabar = false,
): MaProtectionExit | undefined {
  if (!enteredIntrabar && stop !== undefined && direction * (bar.open - stop) <= 0) {
    return { price: bar.open, reason: 'stop', timing: 'open' }
  }
  if (!enteredIntrabar && target !== undefined && direction * (bar.open - target) > 0) {
    return { price: target, reason: 'target', timing: 'open' }
  }

  const adverse = direction > 0 ? bar.low : bar.high
  const favorable = direction > 0 ? bar.high : bar.low
  if (stop !== undefined && direction * (adverse - stop) <= 0) return { price: stop, reason: 'stop', timing: 'intrabar' }
  if (target !== undefined && direction * (favorable - target) > 0 &&
      (!enteredIntrabar || direction * (bar.close - target) > 0)) {
    return { price: target, reason: 'target', timing: 'intrabar' }
  }
}

function tradeFromExit(
  bars: readonly MaBar[], index: number, position: MaPosition, exit: MaExit, feeRate: number, marketExitTicks: number,
) {
  const bar = bars[index]
  const { setup, fill, entryBar, direction } = position
  const { price, reason, timing } = exit
  const gross = direction * (price - fill.price) * maLotSize
  const fee = (fill.price + price) * maLotSize * feeRate
  const slippage = reason === 'target' ? 0 : marketExitTicks * maLotSize
  const net = gross - fee - slippage
  const risk = Math.abs(fill.price - setup.stop) * maLotSize
  return {
    setup, entryIndex: position.index, exitIndex: index, exitTiming: timing,
    contract: entryBar.contract,
    direction: setup.direction,
    sweep: bars[setup.sweep.index].date,
    sweepDay: bars[setup.sweep.index].tradeDate,
    sweptPrice: setup.sweep.liquidity.price,
    shift: bars[setup.shiftIndex].date,
    shiftDay: bars[setup.shiftIndex].tradeDate,
    shiftPrice: setup.sweep.structure.price,
    signal: bars[setup.index].date,
    signalDay: bars[setup.index].tradeDate,
    gapLow: setup.gapLow, gapHigh: setup.gapHigh, limit: setup.entry,
    entry: entryBar.date, entryDay: entryBar.tradeDate, entryPrice: fill.price, entryAtOpen: fill.atOpen,
    stop: setup.stop, target: setup.target,
    exit: bar.date, exitDay: bar.tradeDate, exitPrice: price, reason,
    gross, fee, slippage, net, netR: net / risk,
  }
}

export function simulate(
  bars: readonly MaBar[], { intraday, feeRate, marketExitTicks, start = maWindow.from, trace }: MaOptions,
  setups = ictSetups(bars, 1),
) {
  const setupsByIndex = new Map<number, IctSetup[]>()
  let signalCount = 0
  for (const setup of setups) {
    if (bars[setup.index].tradeDate < start) continue
    signalCount++
    const sameBar = setupsByIndex.get(setup.index)
    if (sameBar) sameBar.push(setup)
    else setupsByIndex.set(setup.index, [setup])
  }

  const trades: MaTrade[] = []
  let pending: IctSetup | undefined
  let position: MaPosition | undefined
  let orders = 0
  let wins = 0
  let realized = 0
  let equity = 0
  let peak = 0
  let maxDrawdown = 0

  function closePosition(index: number, current: MaPosition, exit: MaExit) {
    const trade = tradeFromExit(bars, index, current, exit, feeRate, marketExitTicks)
    trades.push(trade)
    trace?.actions.push({ index, kind: 'exit', trade })
    realized += trade.net
    if (trade.net > 0) wins++
    position = undefined
  }

  function cancel(index: number, setup: IctSetup, reason: MaCancelReason) {
    trace?.actions.push({ index, kind: 'cancel', setup, reason })
    pending = undefined
  }

  for (const [index, bar] of bars.entries()) {
    if (bar.tradeDate < start) continue
    const sampleEnd = index === bars.length - 1
    const dayEnd = intraday && bar.date.endsWith(' 15:00')
    const locked = bar.high === bar.low
    const priorContract = bars[index - 1]?.contract

    if (priorContract && priorContract !== bar.contract) {
      trace?.actions.push({ index, kind: 'roll', from: priorContract, contract: bar.contract })
    }
    if (position && position.entryBar.contract !== bar.contract) {
      if (bar.rollFrom !== position.entryBar.contract || !bar.rollExitOpen) {
        throw new Error('Missing old contract open on ' + bar.tradeDate)
      }
      closePosition(index, position, { price: bar.rollExitOpen, reason: 'roll', timing: 'open' })
    }

    if (pending) {
      if (sampleEnd || dayEnd) cancel(index, pending, sampleEnd ? 'sample_end' : 'day_end')
      else {
        const fill = ictRetest(bars, pending, index)
        if (fill?.kind === 'filled' && !locked) {
          position = { setup: pending, fill, index, entryBar: bar, direction: pending.direction === 'long' ? 1 : -1 }
          trace?.actions.push({ index, kind: 'entry', setup: pending, fill })
          pending = undefined
        } else {
          if (fill?.kind === 'filled') trace?.actions.push({ index, kind: 'entry_wait', setup: pending })
          if (fill?.kind === 'invalidated') cancel(index, pending, 'invalidated')
          else if (fill?.kind === 'expired' || index - pending.index >= ictRetestWindow) {
            const signal = bars[pending.index]
            cancel(index, pending, signal.contract !== bar.contract ? 'roll'
              : signal.tradingDay !== bar.tradingDay ? 'day_end' : 'expired')
          }
        }
      }
    }

    if (position) {
      const enteredIntrabar = position.index === index && !position.fill.atOpen
      const exit = position.deferredExit
        ? { price: bar.open, reason: position.deferredExit, timing: 'open' as const }
        : maProtectionExit(bar, position.direction, position.setup, enteredIntrabar)
      const maxHold = !intraday && index - position.index + 1 >= dailyHoldLimit
      const forced = sampleEnd ? 'sample_end' : dayEnd ? 'day_end' : maxHold ? 'time' : undefined
      if (!locked && exit) closePosition(index, position, exit)
      else if (!locked && forced) closePosition(index, position, { price: bar.close, reason: forced, timing: 'close' })
      else if (locked && !position.deferredExit) {
        const reason = exit?.reason === 'stop' ? 'stop' : forced
        if (reason) {
          position = { ...position, deferredExit: reason }
          trace?.actions.push({ index, kind: 'exit_wait', setup: position.setup, reason })
        }
      }
    }

    const confirmed = setupsByIndex.get(index)
    if (confirmed) {
      const blocker = sampleEnd ? 'sample_end' : dayEnd ? 'day_end' : position ? 'holding' : pending ? 'pending' : undefined
      for (const [offset, setup] of confirmed.entries()) {
        const skipped = offset > 0 ? 'same_bar' : blocker
        trace?.actions.push({ index, kind: 'signal', setup, skipped })
        if (skipped) continue
        pending = setup
        orders++
        trace?.actions.push({ index, kind: 'order', setup })
      }
    }
    const unrealized = position
      ? (position.direction * (bar.close - position.fill.price) - position.fill.price * feeRate) * maLotSize
      : 0
    equity = realized + unrealized
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    if (trace) trace.frames[index] = { pending, position, realized, equity, maxDrawdown, closed: trades.length, wins }
  }
  return { trades, signalCount, orders, maxDrawdown, equity, openPosition: Boolean(position) }
}

export function maReplayStart(bars: MaBar[]) {
  const start = bars.findIndex((bar) => bar.tradeDate >= maWindow.from)
  if (start < 0 || bars[start].tradeDate !== maWindow.from || bars.at(-1)?.tradeDate !== maWindow.through) {
    throw new Error('Incomplete MA backtest window')
  }
  return start
}

export function recordMaReplay(bars: MaBar[], period: MaPeriod) {
  const start = maReplayStart(bars)
  const trace: MaTrace = { actions: [], frames: [] }
  const result = simulate(bars, { intraday: period === '5m', ...maBaseCosts, trace })
  return { bars, start, ...trace, trades: result.trades }
}

export type MaReplayData = ReturnType<typeof recordMaReplay>

