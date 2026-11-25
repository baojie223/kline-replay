import type { MaBar } from './maBacktest.ts'

type MaBarTime = Pick<MaBar, 'date' | 'session' | 'contract'>
export type CandleInterval = { from: number; to: number }
export type MaChartPeriod = 1 | 5 | 15
export type MaReplayPoint = { cursor: number; minute?: number }

export function intradayTimestamp(date: string) {
  return Date.parse(date.replace(' ', 'T') + ':00+08:00') / 1000
}

function minuteOfDay(date: string) {
  return Number(date.slice(11, 13)) * 60 + Number(date.slice(14, 16))
}

// Intermediate minutes are counted from the open of the next traded 5-minute bar.
export function maReplayDate(bars: readonly MaBar[], { cursor, minute }: MaReplayPoint) {
  if (!minute) return bars[cursor].date
  const localSeconds = intradayTimestamp(bars[cursor + 1].date) + 8 * 3600 - (5 - minute) * 60
  return new Date(localSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

export function maNextChartPoint(bars: readonly MaBar[], fifteen: readonly MaBar[], { cursor, minute }: MaReplayPoint,
  period: MaChartPeriod): MaReplayPoint | undefined {
  if (cursor >= bars.length - 1) return
  if (period === 1 && (minute ?? 0) < 4) return { cursor, minute: (minute ?? 0) + 1 }
  if (period !== 15) return { cursor: cursor + 1 }
  const next = fifteen[maChartCursor(fifteen, bars[cursor].date) + 1]
  if (next) return { cursor: maChartCursor(bars, next.date) }
}

export function closesMaFifteenMinutes(first: MaBarTime | undefined, middle: MaBarTime | undefined, last: MaBarTime) {
  if (!first || !middle) return false
  const minute = minuteOfDay(last.date)
  return minute % 15 === 0 && first.session === last.session && middle.session === last.session &&
    first.contract === last.contract && middle.contract === last.contract &&
    minuteOfDay(first.date) === minute - 10 && minuteOfDay(middle.date) === minute - 5
}

export function maFifteenMinuteBars(bars: readonly MaBar[]): MaBar[] {
  const result: MaBar[] = []
  for (let index = 2; index < bars.length; index++) {
    const first = bars[index - 2]
    const middle = bars[index - 1]
    const last = bars[index]
    if (!closesMaFifteenMinutes(first, middle, last)) continue

    result.push(mergeMaBars([first, middle, last], last.date))
  }
  return result
}

function mergeMaBars(parts: MaBar[], date: string): MaBar {
  return {
    ...parts[parts.length - 1], date, open: parts[0].open,
    high: Math.max(...parts.map((bar) => bar.high)),
    low: Math.min(...parts.map((bar) => bar.low)),
    volume: parts.reduce((total, bar) => total + bar.volume, 0),
  }
}

export function maFormingFive(minutes: readonly MaBar[], next: MaBar, minute: number, minuteCursor: number) {
  const parts = minutes.slice(Math.max(0, minuteCursor - minute + 1), minuteCursor + 1)
  if (parts.length !== minute || parts.some((bar, index) => bar.contract !== next.contract || bar.session !== next.session ||
    minuteOfDay(bar.date) !== minuteOfDay(next.date) - 4 + index)) return
  return mergeMaBars(parts, next.date)
}

export function maFifteenMinuteFrame(bars: readonly MaBar[], cursor: number, fifteen: readonly MaBar[], formingFive?: MaBar) {
  const last = formingFive ?? bars[cursor]
  const completed = maChartCursor(fifteen, bars[cursor].date)
  const next = fifteen[completed + 1]
  const remaining = next ? minuteOfDay(next.date) - minuteOfDay(last.date) : 0
  if (!next || last.session !== next.session || last.contract !== next.contract ||
      (remaining !== 5 && remaining !== 10 && !(formingFive && remaining === 0))) {
    return { cursor: completed }
  }
  const count = (15 - remaining) / 5
  const beforeLast = formingFive ? cursor + 1 : cursor
  const parts = [...bars.slice(Math.max(0, beforeLast - count + 1), beforeLast), last]
  if (parts.length !== count || parts.some((bar, index) => bar.contract !== last.contract || bar.session !== last.session ||
    minuteOfDay(bar.date) !== minuteOfDay(next.date) - 10 + index * 5)) return { cursor: completed }
  return { cursor: completed + 1, forming: mergeMaBars(parts, next.date) }
}

export function maChartCursor(bars: readonly MaBar[], date: string) {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (bars[middle].date <= date) low = middle + 1
    else high = middle
  }
  return low - 1
}

// Candles cover (open time, close time]. Adjacent intervals do not overlap.
export function overlappingCandles(times: readonly number[], cursor: number, duration: number, interval: CandleInterval) {
  if (interval.from >= interval.to) return
  const from = firstCandleAt(times, interval.from + 1, cursor)
  if (from > cursor || times[from] - duration >= interval.to) return
  const to = firstCandleAt(times, interval.to, cursor)
  return { from, to: to > cursor || times[to] - duration >= interval.to ? to - 1 : to }
}

export function firstCandleAt(times: readonly number[], time: number, cursor: number) {
  let low = 0
  let high = cursor + 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (times[middle] < time) low = middle + 1
    else high = middle
  }
  return low
}
