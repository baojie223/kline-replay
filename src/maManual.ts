import { maBaseCosts, maLotSize, maProtectionExit } from './maBacktest.ts'
import type { MaBar } from './maBacktest.ts'
import { matchMarketProtection, protectionChangeError, protectionError } from './protection.ts'
import type { ProtectionKind, ProtectionPrices } from './protection.ts'
import { matchPriceEntry, priceEntry, validPriceEntry } from './entryOrder.ts'
import type { PriceEntry } from './entryOrder.ts'
import { intradayTimestamp, maChartCursor, maFifteenMinuteBars, maReplayDate } from './maTimeframes.ts'
import type { MaChartPeriod, MaReplayPoint } from './maTimeframes.ts'

export type MaManualSide = 'long' | 'short'
type OpenOrder = { kind: 'open'; side: MaManualSide; lots: number; stopTicks?: number; targetTicks?: number; protection?: ProtectionPrices; entry?: PriceEntry; period?: MaChartPeriod }
export type MaManualOrder = OpenOrder | { kind: 'close' }
export type MaManualCommand = MaManualOrder | { kind: 'cancel' } | { kind: 'protection'; prices: ProtectionPrices; period?: MaChartPeriod } | { kind: 'entry'; price: number; period?: MaChartPeriod }
type TimedCommand = MaManualCommand & { at: string }
export type MaManualSession = MaReplayPoint & {
  start: number; commands: TimedCommand[]
  legacyProtectionThrough?: string; sideQuoteThrough?: string
}

export type MaManualPosition = {
  side: MaManualSide
  lots: number
  contract: string
  entryIndex: number
  entryPrice: number
  entryDate?: string
  period?: MaChartPeriod
  stop?: number
  target?: number
  deferredExit?: ProtectionKind
}

export type MaManualExit = 'manual' | 'stop' | 'target' | 'roll' | 'sample_end'
export type MaManualTrade = MaManualPosition & {
  exitIndex: number
  exitPrice: number
  exitDate?: string
  exitPeriod?: MaChartPeriod
  reason: MaManualExit
  gross: number
  fees: number
  slippage: number
  net: number
}

export const maMaxMarketLots = 200
export const maManualCosts = { ...maBaseCosts, marketEntryTicks: 1 }
const sign = (side: MaManualSide) => side === 'long' ? 1 : -1
const validPeriod = (period: unknown) => period === undefined || period === 1 || period === 5 || period === 15

export function maManualMarket(bars: MaBar[], minutes: MaBar[]) {
  const fifteen = new Map(maFifteenMinuteBars(bars).map((bar) => [bar.date, bar]))
  return { minutes, fifteen }
}

type ManualMarket = ReturnType<typeof maManualMarket>

export function validMaManualOpen(order: OpenOrder) {
  return (order.side === 'long' || order.side === 'short') && Number.isInteger(order.lots) &&
    order.lots >= 1 && order.lots <= maMaxMarketLots && [order.stopTicks, order.targetTicks].every((ticks) =>
      ticks === undefined || (Number.isSafeInteger(ticks) && ticks > 0)) && validPrices(order.protection) &&
      validPeriod(order.period) && (order.entry === undefined || validPriceEntry(order.entry, 0))
}

function validPrices(prices?: ProtectionPrices) {
  return prices === undefined || (!!prices && typeof prices === 'object' && [prices.stop, prices.target].every((price) =>
    price === undefined || (Number.isSafeInteger(price) && price > 0)))
}

export function newMaManualSession(start: number): MaManualSession {
  return { start, cursor: start, commands: [] }
}

export function stepMaManual(session: MaManualSession, bars: MaBar[], direction: number): MaManualSession {
  const { minute, ...closed } = session
  if (minute && direction === -1) {
    const date = bars[session.cursor].date
    return { ...closed, commands: session.commands.filter(({ at }) => at <= date) }
  }
  const cursor = Math.min(bars.length - 1, Math.max(session.start, session.cursor + direction))
  if (cursor === session.cursor) return session
  if (direction > 0) {
    return carryReplayCache(session, bars, { ...closed, cursor })
  }
  const date = bars[cursor].date
  const commands = session.commands.filter(({ at }) => at <= date)
  const legacy = session.legacyProtectionThrough
  const legacyProtectionThrough = legacy && legacy > date ? date : legacy
  const sideQuote = session.sideQuoteThrough
  const sideQuoteThrough = sideQuote && sideQuote > date ? date : sideQuote
  return { ...closed, cursor, commands, ...(legacyProtectionThrough && { legacyProtectionThrough }), ...(sideQuoteThrough && { sideQuoteThrough }) }
}

function carryReplayCache(session: MaManualSession, bars: MaBar[], next: MaManualSession) {
  const cached = replayCache.get(session)
  if (cached?.bars === bars && cached.commandCount === session.commands.length) replayCache.set(next, cached)
  return next
}

export function advanceMaManual(session: MaManualSession, bars: MaBar[], point: MaReplayPoint): MaManualSession {
  if (point.cursor > session.cursor) return stepMaManual(session, bars, point.cursor - session.cursor)
  if (point.cursor === session.cursor && point.minute && point.minute > (session.minute ?? 0) &&
      point.minute < 5 && Number.isInteger(point.minute) && session.cursor < bars.length - 1) {
    return carryReplayCache(session, bars, { ...session, minute: point.minute })
  }
  return session
}

export function maManualSnapshot(session: MaManualSession, bars: MaBar[]) {
  return {
    version: 3, start: bars[session.start].date, cursor: bars[session.cursor].date,
    commands: session.commands, minute: session.minute, legacyProtectionThrough: session.legacyProtectionThrough, sideQuoteThrough: session.sideQuoteThrough,
  }
}

export function parseMaManualSnapshot(saved: ReturnType<typeof maManualSnapshot> | null, bars: MaBar[], earliest: number): MaManualSession | undefined {
  if (!saved || !Array.isArray(saved.commands)) return
  const start = bars.findIndex((bar) => bar.date === saved.start)
  const cursor = bars.findIndex((bar) => bar.date === saved.cursor)
  if (start < earliest || cursor < start) return
  const minute = saved.minute
  if (minute !== undefined && (!Number.isInteger(minute) || minute < 1 || minute > 4 || cursor >= bars.length - 1)) return
  const dates = new Set(bars.slice(start, Math.min(cursor + 1, bars.length - 1)).map(({ date }) => date))
  const through = maReplayDate(bars, { cursor, minute })
  function hasCandle(at: string) {
    if (dates.has(at)) return true
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at) || at <= bars[start].date || at > through || at >= bars[bars.length - 1].date) return false
    const next = bars[maChartCursor(bars, at) + 1]
    const seconds = next && intradayTimestamp(next.date) - intradayTimestamp(at)
    return seconds >= 60 && seconds <= 240
  }
  if (!saved.commands.every((command, index, commands) =>
    command && typeof command.at === 'string' && hasCandle(command.at) && (!index || command.at >= commands[index - 1].at) &&
    (command.kind === 'close' || command.kind === 'cancel' ||
      (command.kind === 'entry' && validPeriod(command.period) && Number.isSafeInteger(command.price) && command.price > 0) ||
      (command.kind === 'protection' && validPeriod(command.period) && !!command.prices && validPrices(command.prices)) ||
      (command.kind === 'open' && validMaManualOpen(command))))) return
  const legacyProtectionThrough = saved.version >= 2 ? saved.legacyProtectionThrough : saved.cursor
  const sideQuoteThrough = saved.version === 2 ? saved.cursor : saved.sideQuoteThrough
  if ([legacyProtectionThrough, sideQuoteThrough].some((date) => date !== undefined && date !== saved.cursor && !dates.has(date))) return
  return { start, cursor, commands: saved.commands, ...(minute && { minute }), ...(legacyProtectionThrough && { legacyProtectionThrough }), ...(sideQuoteThrough && { sideQuoteThrough }) }
}

export function serializeMaManual(session: MaManualSession, bars: MaBar[]) {
  return JSON.stringify(maManualSnapshot(session, bars))
}

export function restoreMaManual(raw: string | null, bars: MaBar[], earliest: number): MaManualSession {
  try {
    return parseMaManualSnapshot(JSON.parse(raw ?? 'null'), bars, earliest) ?? newMaManualSession(earliest)
  } catch {
    // An unreadable save opens a fresh replay.
  }
  return newMaManualSession(earliest)
}

function legacyProtectionExit(bar: MaBar, position: MaManualPosition, enteredIntrabar: boolean, openedWithPrices: boolean) {
  if (position.deferredExit) return { kind: position.deferredExit, price: bar.open }
  const direction = sign(position.side)
  const exit = maProtectionExit(bar, direction, position, enteredIntrabar)
  if (!exit) return
  const gap = openedWithPrices && !enteredIntrabar && exit.reason === 'target' &&
    direction * (bar.open - (position.target ?? bar.open)) > 0
  return { kind: exit.reason, price: gap ? bar.open : exit.price }
}

type ProtectionRule = { period: MaChartPeriod; at: string }
type ProtectionRules = Partial<Record<ProtectionKind, ProtectionRule>>
type ActivePosition = MaManualPosition & { rules?: ProtectionRules }
type PendingOrder = MaManualOrder & { contract: string; at: string; rules?: ProtectionRules }

type ManualFrame = {
  pending?: PendingOrder
  position?: ActivePosition
  trades: MaManualTrade[]
  notice: string
  realized: number
  unrealized: number
  maxDrawdown: number
  priceOrderFilled: boolean
}

const replayCache = new WeakMap<MaManualSession, {
  bars: MaBar[]; market?: ManualMarket; tick: number; frame: ManualFrame; peak: number; nextCommand: number
  commandCount: number; lastPriceFillTick?: number
}>()

export function replayMaManual(bars: MaBar[], session: MaManualSession, market?: ManualMarket): ManualFrame {
  const { start, cursor, minute, commands, legacyProtectionThrough, sideQuoteThrough } = session
  const lastTick = cursor * 5 + (market ? minute ?? 0 : 0)
  const stride = market ? 1 : 5
  const cached = replayCache.get(session)
  const previous = cached?.bars === bars && cached.market === market && cached.commandCount === commands.length ? cached : undefined
  if (previous?.tick === lastTick) return previous.frame

  let trades = previous?.frame.trades ?? []
  let position = previous?.frame.position
  let pending = previous?.frame.pending
  let notice = previous?.frame.notice ?? ''
  let realized = previous?.frame.realized ?? 0
  let unrealized = previous?.frame.unrealized ?? 0
  let peak = previous?.peak ?? 0
  let maxDrawdown = previous?.frame.maxDrawdown ?? 0
  let lastPriceFillTick = previous?.lastPriceFillTick
  let nextCommand = previous?.nextCommand ?? 0

  function close(current: ActivePosition, index: number, price: number, reason: MaManualExit, date: string,
    period: MaChartPeriod, reference?: number) {
    const units = maLotSize * current.lots
    const direction = sign(current.side)
    const gross = direction * ((reference ?? price) - current.entryPrice) * units
    const fees = (current.entryPrice + price) * units * maManualCosts.feeRate
    const exitTicks = reference === undefined ? reason === 'target' ? 0 : maManualCosts.marketExitTicks : direction * (reference - price)
    const slippage = (maManualCosts.marketEntryTicks + exitTicks) * units
    const net = gross - fees - slippage
    if (trades === previous?.frame.trades) trades = trades.slice()
    const { rules: _rules, ...summary } = current
    trades.push({ ...summary, exitIndex: index, exitPrice: price, reason, gross, fees, slippage, net,
      ...(date !== bars[index].date && { exitDate: date }), ...(period !== 5 && { exitPeriod: period }) })
    realized += net
    position = undefined
    notice = ''
  }

  function canTrade(bar: MaBar, period: MaChartPeriod) {
    return bar.volume > 0 && (period === 1 || bar.high !== bar.low)
  }

  function revisedRules(before: ProtectionPrices, after: ProtectionPrices, rules: ProtectionRules | undefined,
    fallback: MaChartPeriod, command: Extract<MaManualCommand, { kind: 'protection' }> & { at: string }) {
    const next = { ...rules }
    for (const kind of ['stop', 'target'] as const) {
      if (before[kind] === after[kind]) continue
      if (after[kind] === undefined) delete next[kind]
      else next[kind] = { period: command.period ?? rules?.[kind]?.period ?? fallback, at: command.at }
    }
    return next
  }

  // Tick zero is the first 5-minute close, aligned with the fifth 1-minute candle.
  for (let tick = previous ? previous.tick + stride : start * 5; tick <= lastTick; tick += stride) {
    const index = Math.ceil(tick / 5)
    const five = bars[index]
    const closeFive = tick % 5 === 0
    const bar = market?.minutes[tick + 4] ?? five
    if (!position && !pending && commands[nextCommand]?.at !== bar.date) continue
    const sampleEnd = closeFive && index === bars.length - 1
    const at = intradayTimestamp(bar.date)
    function matchingBar(period: MaChartPeriod, submitted?: string) {
      if (submitted && intradayTimestamp(submitted) > at - period * 60) return
      if (period === 5) return closeFive ? five : undefined
      if (period === 1) return market ? bar : undefined
      return closeFive ? market?.fifteen.get(five.date) : undefined
    }
    let openedWithPrices = false
    let enteredIntrabar = false
    let openedPeriod: MaChartPeriod | undefined

    const pendingPeriod = pending?.kind === 'open' ? pending.period ?? 5 : 5
    const minuteProtection = position && (position.period === 1 || position.rules?.stop?.period === 1 || position.rules?.target?.period === 1)
    if (position && position.contract !== bar.contract && (closeFive || minuteProtection)) {
      if (five.rollFrom !== position.contract || five.rollExitOpen === undefined) {
        throw new Error('Missing old contract open on ' + five.tradeDate)
      }
      close(position, index, five.rollExitOpen, 'roll', bar.date, closeFive ? 5 : 1)
      notice = '合约切换，持仓已按旧合约开盘价平仓。'
    }
    if (pending && pending.contract !== bar.contract && (closeFive || pendingPeriod === 1)) {
      pending = undefined
      notice = '合约切换，旧合约委托已撤销。'
    }

    const orderBar = pending && matchingBar(pendingPeriod, pending.at)
    const matched = orderBar && pending && (pending.kind === 'open' && pending.entry
      ? matchPriceEntry(orderBar, pending.entry, sign(pending.side)) : { price: orderBar.open, intrabar: false })
    if (pending && pending.contract === bar.contract && orderBar && canTrade(orderBar, pendingPeriod) && matched) {
      if (pending.kind === 'open') {
        const { side, lots, stopTicks, targetTicks } = pending
        const direction = sign(side)
        const stop = pending.protection ? pending.protection.stop : stopTicks === undefined ? undefined : matched.price - direction * stopTicks
        const target = pending.protection ? pending.protection.target : targetTicks === undefined ? undefined : matched.price + direction * targetTicks
        if ((stop !== undefined && !Number.isSafeInteger(stop)) || (target !== undefined && !Number.isSafeInteger(target)) ||
            (stop ?? 1) <= 0 || (target ?? 1) <= 0) {
          notice = '开盘价使止盈或止损价格超出有效报价，委托已撤销。'
        } else {
          position = { side, lots, contract: bar.contract, entryIndex: index, entryPrice: matched.price, stop, target,
            ...(bar.date !== five.date && { entryDate: bar.date }), ...(pendingPeriod !== 5 && { period: pendingPeriod }),
            ...(pending.rules && { rules: pending.rules }) }
          if (pending.entry) lastPriceFillTick = tick
          openedPeriod = pendingPeriod
          openedWithPrices = !!pending.protection
          enteredIntrabar = matched.intrabar
          notice = ''
        }
      } else if (position && !position.deferredExit) {
        close(position, index, orderBar.open, 'manual', bar.date, pendingPeriod)
      }
      pending = undefined
    }

    if (position?.contract === bar.contract) {
      const useLegacy = legacyProtectionThrough !== undefined && bar.date <= legacyProtectionThrough
      const stopPeriod = position.rules?.stop?.period ?? position.period ?? 5
      const targetPeriod = position.rules?.target?.period ?? position.period ?? 5
      const periods = stopPeriod === targetPeriod ? [stopPeriod] : [stopPeriod, targetPeriod]
      let triggered: ProtectionKind | undefined
      for (const period of periods) {
        if (openedPeriod !== undefined && openedPeriod !== period) continue
        const quote = matchingBar(period, position.entryDate ?? bars[position.entryIndex].date)
        // The position's own entry candle can also trigger protection.
        const protectionBar = quote ?? (openedPeriod === period ? orderBar : undefined)
        if (!protectionBar) continue
        const stop = period === stopPeriod && (!position.rules?.stop || matchingBar(period, position.rules.stop.at)) ? position.stop : undefined
        const target = period === targetPeriod && (!position.rules?.target || matchingBar(period, position.rules.target.at)) ? position.target : undefined
        const deferred = position.deferredExit
        if (deferred && (deferred === 'stop' ? stopPeriod : targetPeriod) !== period) continue
        const exit: { kind: ProtectionKind; price: number; reference?: number } | undefined = useLegacy
          ? legacyProtectionExit(protectionBar, position, enteredIntrabar, openedWithPrices)
          : matchMarketProtection(protectionBar, { stop, target }, sign(position.side), 0, {
            enteredIntrabar, triggered: deferred, useSideQuote: sideQuoteThrough !== undefined && bar.date <= sideQuoteThrough,
          })
        if (!exit) continue
        if (canTrade(protectionBar, period)) close(position, index, exit.price, exit.kind, bar.date, period, exit.reference)
        else if (!useLegacy || exit.kind === 'stop') triggered = exit.kind
        break
      }
      if (position && sampleEnd && canTrade(five, 5)) close(position, index, five.close, 'sample_end', five.date, 5)
      else if (position && triggered) position = { ...position, deferredExit: triggered }
    }

    if (sampleEnd && pending) {
      pending = undefined
      notice = '已到行情末尾，剩余委托已撤销。'
    }

    // Decisions at this timestamp are submitted only after the candle closes.
    while (commands[nextCommand]?.at === bar.date) {
      const command = commands[nextCommand++]
      notice = ''
      if (command.kind === 'cancel') pending = undefined
      else if (command.kind === 'entry') {
        if (pending?.kind === 'open' && pending.entry) {
          const entry = priceEntry(command.price, bar.close, sign(pending.side))
          const error = !validPriceEntry(entry, 0) ? '挂单价需为正整数。'
            : pending.protection && protectionError(pending.protection, entry.price, sign(pending.side), 0)
          if (error) notice = error
          else pending = { ...pending, entry, at: command.at, period: command.period ?? pending.period }
        }
      }
      else if (command.kind === 'protection') {
        const error = pending?.kind === 'open'
          ? protectionError(command.prices, pending.entry?.price ?? bar.close, sign(pending.side), 0)
          : position && protectionChangeError(command.prices, position, bar.close, sign(position.side), 0)
        if (error) notice = error
        else if (pending?.kind === 'open') pending = { ...pending, protection: command.prices,
          rules: revisedRules(pending.protection ?? {}, command.prices, pending.rules, pending.period ?? 5, command) }
        else if (position && !position.deferredExit) position = { ...position, stop: command.prices.stop, target: command.prices.target,
          rules: revisedRules(position, command.prices, position.rules, position.period ?? 5, command) }
      } else if (!pending && (command.kind === 'open' ? !position : position)) {
        const error = command.kind === 'open' && command.protection &&
          protectionError(command.protection, command.entry?.price ?? bar.close, sign(command.side), 0)
        if (error) notice = error
        else pending = { ...command, contract: bar.contract }
      }
    }

    unrealized = position && position.contract === bar.contract
      ? (sign(position.side) * (bar.close - position.entryPrice) - position.entryPrice * maManualCosts.feeRate -
        maManualCosts.marketEntryTicks) * position.lots * maLotSize
      : position ? unrealized : 0
    if (closeFive) {
      const equity = realized + unrealized
      peak = Math.max(peak, equity)
      maxDrawdown = Math.max(maxDrawdown, peak - equity)
    }
  }
  const priceOrderFilled = lastPriceFillTick !== undefined && lastPriceFillTick > lastTick - (minute ? 1 : 5)
  const frame = { pending, position, trades, notice, realized, unrealized, maxDrawdown, priceOrderFilled }
  replayCache.set(session, { bars, market, tick: lastTick, frame, peak, nextCommand, commandCount: commands.length, lastPriceFillTick })
  return frame
}
