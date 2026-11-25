import type { Bar } from './replay'

type HighTwo = { date: string; signalDate: string; trigger: number }
type Pattern = 'h2' | 'wedgeFlag' | 'wedgeReversal' | 'range'
type Point = { index: number; price: number; side: 'high' | 'low' }
type Wedge = { start: Point; lows: [Point, Point, Point]; rebound: Point }
type Setup = { pattern: Pattern; evidence: Point[]; detail: string }
export type BrooksEntry = HighTwo & { pattern: Pattern; evidence: { date: string; price: number }[]; detail: string }
type Pullback = { high: number; phase: 'first' | 'second-leg' | 'second' | 'triggered' }

const emaPeriod = 20
const slopeLookback = 5
function buyTrigger(high: number) {
  return (Math.round(high * 1000) + 1) / 1000
}

export function brooksHighTwos(bars: readonly Bar[], cursor: number) {
  const entries: HighTwo[] = []
  const ema: number[] = []
  let pullback: Pullback | undefined

  for (let index = 0; index <= cursor; index++) {
    const bar = bars[index]
    const previousEma = ema[index - 1] ?? bar.close
    ema.push(previousEma + (bar.close - previousEma) * 2 / (emaPeriod + 1))
    if (index < emaPeriod + slopeLookback) continue

    const previous = bars[index - 1]
    if (previousEma <= ema[index - 1 - slopeLookback]) {
      pullback = undefined
      continue
    }

    const breaksLow = bar.low < previous.low
    const trigger = buyTrigger(previous.high)
    const breaksHigh = bar.high >= trigger

    if (!pullback) {
      if (previous.close > previousEma && breaksLow && !breaksHigh) {
        pullback = { high: previous.high, phase: 'first' }
      }
      continue
    }

    if (pullback.phase === 'first' && breaksHigh) {
      pullback.phase = 'second-leg'
    } else if (pullback.phase === 'second-leg' && breaksLow) {
      // A daily outside bar cannot establish and finish the second leg in a known order.
      pullback.phase = 'second'
    } else if (pullback.phase === 'second' && breaksHigh) {
      entries.push({ date: bar.date, signalDate: previous.date, trigger })
      pullback.phase = 'triggered'
    }

    if (bar.high > pullback.high) pullback = undefined
  }

  return entries
}

// A swing is known at the close of the bar to its right. Small reversals do not start a new leg.
function updateSwings(points: Point[], bars: readonly Bar[], index: number, atr: number) {
  const left = bars[index - 2]
  const bar = bars[index - 1]
  const right = bars[index]
  const high = bar.high >= left.high && bar.high > right.high
  const low = bar.low <= left.low && bar.low < right.low
  if (high === low) return

  const point: Point = { index: index - 1, price: high ? bar.high : bar.low, side: high ? 'high' : 'low' }
  const last = points.at(-1)
  if (!last) points.push(point)
  else if (last.side === point.side) {
    if (high ? point.price >= last.price : point.price <= last.price) points[points.length - 1] = point
    else return
  } else if ((high ? point.price - last.price : last.price - point.price) >= atr * 0.8) points.push(point)
  else return
  return point
}

function threePushes(points: Point[], latest: Point | undefined): Wedge | undefined {
  if (latest?.side !== 'low' || points.length < 6) return
  const [start, first, firstRebound, second, rebound, third] = points.slice(-6)
  const duration = third.index - first.index
  if (duration >= 4 && duration <= 30 && start.index >= third.index - 40 &&
    start.price > Math.max(firstRebound.price, rebound.price) && first.price > second.price && second.price > third.price) {
    return { start, lows: [first, second, third], rebound }
  }
}

function rangeSetup(bar: Bar, history: Point[], index: number, atr: number, emaChange: number): Setup | undefined {
  if (Math.abs(emaChange) > atr * 1.2) return
  const points = history.filter((point) => point.index >= index - 40 && point.index <= index - 2)
  const highs = points.filter((point) => point.side === 'high')
  const lows = points.filter((point) => point.side === 'low')
  if (highs.length < 2 || lows.length < 2) return
  const resistance = Math.max(...highs.map((point) => point.price))
  const support = Math.min(...lows.map((point) => point.price))
  const width = resistance - support
  if (width < 2.5 * atr || bar.low > support + 0.6 * atr || bar.close < support ||
    bar.close > support + width / 3 || buyTrigger(bar.high) >= support + width / 2) return

  const visits: Point[] = []
  for (const point of points) {
    const boundary = point.side === 'high' ? resistance : support
    if (Math.abs(point.price - boundary) > Math.min(atr * 1.3, width / 3)) continue
    if (visits.at(-1)?.side === point.side) visits[visits.length - 1] = point
    else visits.push(point)
  }
  if (visits.length < 4) return
  return {
    pattern: 'range', evidence: visits.slice(-4),
    detail: `${bar.low < support ? '跌破后收回' : '测试'}区间下沿 ¥${support.toFixed(3)} · 上沿 ¥${resistance.toFixed(3)}`,
  }
}

function bullSignal(bar: Bar) {
  const span = bar.high - bar.low
  return span > 0 && bar.close - bar.open >= span / 4 && bar.high - bar.close <= span / 3
}

export function brooksEntries(bars: readonly Bar[], cursor: number): BrooksEntry[] {
  const entries: BrooksEntry[] = brooksHighTwos(bars, cursor).map((entry) => ({
    ...entry, pattern: 'h2', evidence: [], detail: '上行背景 · 两段回调后第二次上攻',
  }))
  const ema: number[] = []
  const points: Point[] = []
  let atr = 0
  let flag: Wedge | undefined
  let reversal: (Wedge & { breakout?: number }) | undefined
  let pending: Setup[] = []

  for (let index = 0; index <= cursor; index++) {
    const bar = bars[index]
    const previous = bars[index - 1]
    const previousEma = ema.at(-1) ?? bar.close
    ema.push(previousEma + (bar.close - previousEma) * 2 / (emaPeriod + 1))
    const span = Math.max(bar.high, previous?.close ?? bar.close) - Math.min(bar.low, previous?.close ?? bar.close)
    atr = index === 0 ? span : atr + (span - atr) / emaPeriod
    if (index < 2) continue

    const latest = updateSwings(points, bars, index, atr)
    if (index < emaPeriod + slopeLookback || atr <= 0) continue

    const trigger = buyTrigger(previous.high)
    // A gap below the signal low invalidates the setup before the stop entry could trigger.
    if (bar.open >= previous.low && bar.high >= trigger) {
      for (const setup of pending) entries.push({
        ...setup, date: bar.date, signalDate: previous.date, trigger,
        evidence: setup.evidence.map(({ index, price }) => ({ date: bars[index].date, price })),
      })
    }
    pending = []

    const wedge = threePushes(points, latest)
    if (wedge && wedge.start.index >= emaPeriod + slopeLookback) {
      const anchor = wedge.start.index
      const slope = ema[anchor] - ema[anchor - slopeLookback]
      if (slope > 0 && bars[anchor].close > ema[anchor]) flag = wedge
      if (slope < 0 && bars[anchor].close < ema[anchor]) reversal = wedge
    }

    const flagLow = flag?.lows[2]
    if (flagLow && (bar.low < flagLow.price || index > flagLow.index + 3)) flag = undefined

    if (reversal) {
      const low = reversal.lows[2]
      if (bar.low < low.price || index > low.index + 25) reversal = undefined
      else if (reversal.breakout === undefined && bar.close > reversal.rebound.price) reversal.breakout = index
    }

    if (!bullSignal(bar)) continue
    if (flag) {
      pending.push({ pattern: 'wedgeFlag', evidence: flag.lows, detail: '上行背景 · 三推回调后向上反转' })
      flag = undefined
    }
    if (reversal?.breakout !== undefined && latest?.side === 'low' && latest.index > reversal.breakout &&
      latest.price > reversal.lows[2].price) {
      pending.push({
        pattern: 'wedgeReversal', evidence: [...reversal.lows, latest],
        detail: `三推下跌后上破 ¥${reversal.rebound.price.toFixed(3)} · 回踩形成更高低点`,
      })
      reversal = undefined
    }
    const range = rangeSetup(bar, points, index, atr, ema[index] - ema[index - 10])
    if (range) pending.push(range)
  }

  return entries.sort((first, second) => first.date.localeCompare(second.date))
}
