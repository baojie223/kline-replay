import type { Bar } from './replay'

export type IctBar = Bar & {
  segment?: string
  tradingDay?: string
  session?: string
}

export type IctDirection = 'long' | 'short'
type Swing = { index: number; price: number }
type Sweep = { index: number; extreme: number; liquidity: Swing; structure: Swing }
type Shift = { index: number; sweep: Sweep }
type DirectionState = { liquidity: Swing[]; structure?: Swing; sweep?: Sweep; shift?: Shift }

export type IctSetup = {
  direction: IctDirection
  index: number
  shiftIndex: number
  sweep: Sweep
  gapLow: number
  gapHigh: number
  entry: number
  stop: number
  target: number
}

export type IctFill = { kind: 'filled'; price: number; atOpen: boolean }
type Retest = IctFill | { kind: 'expired' | 'invalidated' } | null

const lookback = 14
const maxSwingAge = 40
const shiftWindow = 6
const gapWindow = 2
export const ictRetestWindow = 5
const sides = ['long', 'short'] as const

function swingAt(bars: readonly IctBar[], index: number, wing: number, long: boolean): Swing | undefined {
  const field = long ? 'low' : 'high'
  const price = bars[index][field]
  for (let offset = 1; offset <= wing; offset++) {
    const before = bars[index - offset][field]
    const after = bars[index + offset][field]
    if (long ? price >= before || price >= after : price <= before || price <= after) return
  }
  return { index, price }
}

function gapAfterShift(
  bars: readonly IctBar[], index: number, direction: IctDirection, shift: Shift, tickSize: number,
): IctSetup | undefined {
  const { sweep } = shift
  const first = bars[index - 2]
  const middle = bars[index - 1]
  const third = bars[index]
  if (index - 1 <= sweep.index) return
  if (first.session !== middle.session || middle.session !== third.session) return
  const long = direction === 'long'
  const body = long ? middle.close - middle.open : middle.open - middle.close
  if (body <= 0 || body < 0.5 * (middle.high - middle.low)) return
  const low = long ? first.high : third.high
  const high = long ? third.low : first.low
  if (high - low < 2) return
  const entry = long ? high : low
  const stop = sweep.extreme + (long ? -1 : 1)
  if (long ? low <= stop : high >= stop) return

  const price = (ticks: number) => Number((ticks * tickSize).toPrecision(12))
  const priceSwing = (swing: Swing) => ({ ...swing, price: price(swing.price) })
  return {
    direction, index, shiftIndex: shift.index, gapLow: price(low), gapHigh: price(high),
    sweep: {
      index: sweep.index, extreme: price(sweep.extreme),
      liquidity: priceSwing(sweep.liquidity), structure: priceSwing(sweep.structure),
    },
    entry: price(entry), stop: price(stop), target: price(entry + 2 * (entry - stop)),
  }
}

export function ictSetups(bars: readonly IctBar[], tickSize: number): IctSetup[] {
  if (!Number.isFinite(tickSize) || tickSize <= 0) throw new RangeError('Invalid tick size')
  const quotes = bars.map((bar) => ({
    ...bar, open: Math.round(bar.open / tickSize), high: Math.round(bar.high / tickSize),
    low: Math.round(bar.low / tickSize), close: Math.round(bar.close / tickSize),
  }))
  const setups: IctSetup[] = []
  const bodies: number[] = []
  let segmentStart = 0
  let bodySum = 0
  let state: Record<IctDirection, DirectionState> = { long: { liquidity: [] }, short: { liquidity: [] } }

  for (const [index, bar] of quotes.entries()) {
    const previous = quotes[index - 1]
    if (previous && previous.segment !== bar.segment) {
      segmentStart = index
      bodySum = 0
      state = { long: { liquidity: [] }, short: { liquidity: [] } }
    }
    const age = index - segmentStart
    for (const direction of sides) {
      const long = direction === 'long'
      const side = state[direction]
      if (age >= 2) side.structure = swingAt(quotes, index - 1, 1, long) ?? side.structure
      const liquidity = age >= 4 ? swingAt(quotes, index - 2, 2, long) : undefined
      if (liquidity) side.liquidity.push(liquidity)
    }
    for (const direction of sides) {
      const long = direction === 'long'
      const side = state[direction]
      const structure = state[long ? 'short' : 'long'].structure
      const extreme = long ? bar.low : bar.high

      const sweep = side.sweep
      if (sweep) {
        const brokeStructure = long ? bar.close > sweep.structure.price : bar.close < sweep.structure.price
        if (index - sweep.index > shiftWindow) side.sweep = undefined
        else {
          sweep.extreme = long ? Math.min(sweep.extreme, extreme) : Math.max(sweep.extreme, extreme)
          if (brokeStructure) {
            const body = long ? bar.close - bar.open : bar.open - bar.close
            if (age >= lookback && body > 0 && body >= Math.max(1.25 * bodySum / lookback, 0.5 * (bar.high - bar.low))) {
              side.shift = { index, sweep }
            }
            side.sweep = undefined
          }
        }
      }

      const shift = side.shift
      if (shift) {
        const extended = long ? extreme < shift.sweep.extreme : extreme > shift.sweep.extreme
        if (extended || index - shift.index > gapWindow) side.shift = undefined
        else {
          const setup = gapAfterShift(quotes, index, direction, shift, tickSize)
          if (setup) {
            setups.push(setup)
            side.shift = undefined
          }
        }
      }

      let crossed: Swing | undefined
      side.liquidity = side.liquidity.filter((level) => {
        if (index - level.index > maxSwingAge) return false
        if (long ? extreme >= level.price : extreme <= level.price) return true
        crossed = level
        return false
      })
      if (!crossed || !structure || side.sweep || side.shift) continue
      if (long
        ? bar.close >= structure.price || crossed.price >= structure.price
        : bar.close <= structure.price || crossed.price <= structure.price) continue
      side.sweep = { index, extreme, liquidity: crossed, structure }
    }
    for (const direction of sides) {
      const swing = state[direction].structure
      if (swing && (direction === 'long' ? bar.close < swing.price : bar.close > swing.price)) {
        state[direction].structure = undefined
      }
    }
    const body = Math.abs(bar.close - bar.open)
    bodies.push(body)
    bodySum += body
    if (age >= lookback) bodySum -= bodies[index - lookback]
  }
  return setups
}

export function ictRetest(bars: readonly IctBar[], setup: IctSetup, index: number): Retest {
  if (index <= setup.index) return null
  const bar = bars[index]
  const signal = bars[setup.index]
  if (index - setup.index > ictRetestWindow || bar.segment !== signal.segment || bar.tradingDay !== signal.tradingDay) {
    return { kind: 'expired' }
  }
  if (!bar.volume) return null
  const long = setup.direction === 'long'
  if (long ? bar.open <= setup.stop : bar.open >= setup.stop) return { kind: 'invalidated' }
  if (long ? bar.open < setup.entry : bar.open > setup.entry) {
    return { kind: 'filled', price: bar.open, atOpen: true }
  }
  if (long ? bar.low < setup.entry : bar.high > setup.entry) return { kind: 'filled', price: setup.entry, atOpen: false }
  return null
}
