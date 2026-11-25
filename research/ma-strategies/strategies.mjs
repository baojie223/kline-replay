import { ictRetestWindow, ictSetups } from '../../src/ict.ts'

export const models = {
  pa_h2: 'PA H2/L2 二次入场',
  pa_bp: 'PA 突破回踩',
  ict_fvg: 'ICT 扫荡 → MSS → FVG',
  ict_prior: 'ICT 前日高低点扫回',
  smc_bos: 'SMC 顺势 BOS → OB',
  smc_choch: 'SMC 反向 CHoCH → OB',
  wy_spring: '维科夫 Spring/UT 与缩量测试',
  wy_sos: '维科夫 SOS/SOW 与缩量回踩',
  control_h1: '对照 H1/L1 首次入场',
  control_break: '对照 20 根通道突破',
  control_spring: '对照 Spring/UT 与价格测试',
  control_sos: '对照 SOS/SOW 与价格回踩',
}

const directions = [1, -1]
export const front = (bar, direction) => direction === 1 ? bar.high : -bar.low
export const rear = (bar, direction) => direction === 1 ? bar.low : -bar.high
const minimumWarmup = 25

// Each quote is observed at its close. Order eligibility starts on the next bar.
export function signal(direction, index, kind, stop, { entry, reference, origin = index, life = 1, ...management } = {}) {
  return { direction, index, kind, stop, entry, reference, origin, life, ...management }
}

export function features(bars) {
  const context = []
  let start = 0
  let bodies = 0
  let day
  let previousDay
  let timeVolumes = new Map()
  for (const [index, bar] of bars.entries()) {
    const previous = bars[index - 1]
    if (!previous || bar.contract !== previous.contract) {
      start = index
      bodies = 0
      day = previousDay = undefined
      timeVolumes = new Map()
    }
    if (day?.date !== bar.tradeDate) {
      previousDay = day
      day = { date: bar.tradeDate, high: bar.high, low: bar.low }
    }
    day.high = Math.max(day.high, bar.high)
    day.low = Math.min(day.low, bar.low)

    const age = index - start
    const previousEma = age ? context[index - 1].ema : bar.close
    const previousClose = age ? previous.close : bar.open
    const span = Math.max(bar.high, previousClose) - Math.min(bar.low, previousClose)
    const previousAtr = age ? context[index - 1].atr : span
    const body = Math.abs(bar.close - bar.open)
    const slot = bar.date.slice(11)
    const volumes = timeVolumes.get(slot) ?? []
    const volumeMean = volumes.length >= 5 ? volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length : 0
    context.push({
      age, previousDay, ema: previousEma + (bar.close - previousEma) * 2 / 21,
      atr: previousAtr + (span - previousAtr) / 14,
      body, bodyMean: age >= 14 ? bodies / 14 : undefined,
      relativeVolume: volumeMean > 0 ? bar.volume / volumeMean : undefined,
    })
    volumes.push(bar.volume)
    if (volumes.length > 20) volumes.shift()
    timeVolumes.set(slot, volumes)
    bodies += body
    if (age >= 14) bodies -= context[index - 14].body
  }
  return context
}

function displacement(bar, bodyMean, direction) {
  const body = direction * (bar.close - bar.open)
  return body > 0 && body >= Math.max(1.25 * bodyMean, 0.5 * (bar.high - bar.low))
}

function brooksSignals(bars, info, out) {
  for (const direction of directions) {
    let pullback
    for (let index = 1; index < bars.length; index++) {
      const bar = bars[index]
      const previous = bars[index - 1]
      const { age, ema, atr } = info[index]
      if (age < minimumWarmup || direction * (info[index - 1].ema - info[index - 6].ema) <= 0) {
        pullback = undefined
        continue
      }

      const top = front(bar, direction)
      const bottom = rear(bar, direction)
      const up = top > front(previous, direction)
      const down = bottom < rear(previous, direction)
      if (pullback && (top > pullback.peak || index - pullback.index > 20)) pullback = undefined
      if (!pullback) {
        if (direction * (previous.close - info[index - 1].ema) <= 0 || !down || up) continue
        pullback = { index, peak: front(previous, direction), extreme: bottom, phase: 1 }
      } else {
        pullback.extreme = Math.min(pullback.extreme, bottom)
        if (pullback.phase === 1 && up) pullback.phase = 2
        else if (pullback.phase === 2 && down) pullback.phase = 3
        else if (pullback.phase === 3 && up) pullback.phase = 4
      }

      const nearEma = pullback.extreme <= direction * ema + 0.5 * atr
      if (!nearEma || (pullback.phase !== 1 && pullback.phase !== 3)) continue
      const name = pullback.phase === 1 ? 'control_h1' : 'pa_h2'
      out[name].push(signal(direction, index, 'stop', direction * (pullback.extreme - 1), {
        entry: direction * (top + 1), reference: direction * pullback.peak, origin: pullback.index,
      }))
    }
  }
}

function rangeAt(bars, index, count) {
  let low = Infinity
  let high = -Infinity
  for (let position = index - count; position < index; position++) {
    const bar = bars[position]
    low = Math.min(low, bar.low)
    high = Math.max(high, bar.high)
  }
  return { low, high, width: high - low }
}

function breakoutSignals(bars, info, out) {
  for (const direction of directions) {
    let breakout
    for (let index = 20; index < bars.length; index++) {
      const bar = bars[index]
      if (info[index].age < 20) {
        breakout = undefined
        continue
      }
      const close = direction * bar.close
      const bottom = rear(bar, direction)
      if (breakout) {
        if (bar.tradeDate !== breakout.day || index - breakout.index > 6 || close <= breakout.edge) {
          breakout = undefined
        } else if (bottom <= breakout.edge + 1) {
          if (bottom >= breakout.edge - info[index - 1].atr) {
            out.pa_bp.push(signal(direction, index, 'stop', direction * (bottom - 1), {
              entry: direction * (front(bar, direction) + 1), reference: direction * breakout.edge,
              origin: breakout.index,
            }))
          }
          breakout = undefined
        }
      }
      const edge = front(rangeAt(bars, index, 20), direction)
      if (close <= edge || direction * bar.open > edge) continue
      out.control_break.push(signal(direction, index, 'market', direction * (bottom - 1), {
        reference: direction * edge,
      }))
      breakout ??= { index, edge, day: bar.tradeDate }
    }
  }
}

function ictSignals(bars, info, out) {
  for (const setup of ictSetups(bars, 1)) {
    out.ict_fvg.push(signal(setup.direction === 'long' ? 1 : -1, setup.index, 'limit', setup.stop, {
      entry: setup.entry, reference: setup.sweep.liquidity.price, origin: setup.sweep.index, life: ictRetestWindow,
    }))
  }
  for (const direction of directions) {
    let usedDay
    for (const [index, bar] of bars.entries()) {
      const { previousDay } = info[index]
      if (!previousDay || usedDay === bar.tradeDate) continue
      const edge = rear(previousDay, direction)
      const extreme = rear(bar, direction)
      if (extreme >= edge || direction * bar.close <= edge) continue
      usedDay = bar.tradeDate
      out.ict_prior.push(signal(direction, index, 'market', direction * (extreme - 1), {
        reference: direction * edge,
      }))
    }
  }
}

function confirmedPivot(bars, index, direction) {
  const high = front(bars[index], direction)
  for (const offset of [-2, -1, 1, 2]) {
    if (high <= front(bars[index + offset], direction)) return undefined
  }
  return { index, high, broken: false }
}

function orderBlock(bars, index, direction, pullbackIndex) {
  for (let position = index - 1; position >= Math.max(index - 10, pullbackIndex); position--) {
    const candidate = bars[position]
    if (candidate.session !== bars[index].session) return undefined
    if (direction * (candidate.close - candidate.open) < 0) return candidate
  }
}

function smcSignals(bars, info, out) {
  let pivots = { 1: [], '-1': [] }
  for (const [index, bar] of bars.entries()) {
    if (info[index].age === 0) pivots = { 1: [], '-1': [] }
    if (info[index].age < 4) continue
    for (const direction of directions) {
      const current = confirmedPivot(bars, index - 2, direction)
      if (current) pivots[direction] = [pivots[direction].at(-1), current]
    }
    for (const direction of directions) {
      const [older, level] = pivots[direction]
      const [olderOpposite, opposite] = pivots[-direction]
      if (!level || level.broken || direction * bar.close <= level.high) continue
      level.broken = true
      if (!older || !olderOpposite || index - Math.min(older.index, olderOpposite.index) > 60 ||
          !displacement(bar, info[index].bodyMean, direction)) continue

      const continues = level.high > older.high && opposite.high < olderOpposite.high
      const reverses = level.high < older.high && opposite.high > olderOpposite.high
      if (!continues && !reverses) continue
      const block = orderBlock(bars, index, direction, opposite.index)
      if (!block || direction * bar.close <= front(block, direction)) continue
      const name = continues ? 'smc_bos' : 'smc_choch'
      out[name].push(signal(direction, index, 'limit', direction * (rear(block, direction) - 1), {
        entry: direction * front(block, direction), reference: direction * level.high, origin: level.index, life: 5,
      }))
    }
  }
}

function boxAt(bars, index, atr) {
  const start = index - 24
  const box = rangeAt(bars, index, 24)
  if (box.width < 2 * atr || box.width > 8 * atr ||
      Math.abs(bars[index - 1].close - bars[start].close) > 0.4 * box.width) return undefined

  for (const direction of directions) {
    const edge = front(box, direction)
    let first = index
    let last = start - 1
    for (let position = start; position < index; position++) {
      if (front(bars[position], direction) < edge - 0.2 * box.width) continue
      first = Math.min(first, position)
      last = position
    }
    if (last - first < 3) return undefined
  }
  return box
}

function volumeTest(event, relativeVolume) {
  return relativeVolume <= 1 && relativeVolume <= 0.8 * event.relativeVolume
}

function wyckoffSignals(bars, info, out) {
  for (const direction of directions) {
    let spring
    let sos
    for (let index = 24; index < bars.length; index++) {
      const bar = bars[index]
      if (info[index].age < 24) {
        spring = sos = undefined
        continue
      }
      const { relativeVolume, bodyMean } = info[index]
      const atr = info[index - 1].atr
      const bottom = rear(bar, direction)
      const close = direction * bar.close
      const valid = (event) => event && event.session === bar.session && index - event.index <= 8

      if (!valid(spring) || bottom <= spring.extreme || close <= spring.edge) spring = undefined
      if (spring && bottom <= spring.edge + 0.25 * spring.width && close < spring.edge + spring.width) {
        const order = signal(direction, index, 'market', direction * (spring.extreme - 1), {
          reference: direction * spring.edge, origin: spring.index,
        })
        out.control_spring.push(order)
        if (volumeTest(spring, relativeVolume)) out.wy_spring.push(order)
        spring = undefined
      }

      if (!valid(sos) || close <= sos.edge) sos = undefined
      if (sos && bottom <= sos.edge + 0.25 * sos.width) {
        if (bottom >= sos.edge - 0.25 * sos.width) {
          const order = signal(direction, index, 'market', direction * (bottom - 1), {
            reference: direction * sos.edge, origin: sos.index,
          })
          out.control_sos.push(order)
          if (sos.relativeVolume >= 1.5 && volumeTest(sos, relativeVolume)) out.wy_sos.push(order)
        }
        sos = undefined
      }

      const box = boxAt(bars, index, atr)
      if (!box) continue
      const floor = rear(box, direction)
      const ceiling = front(box, direction)
      if (!spring && bottom < floor && floor - bottom <= atr && close > floor && close <= floor + box.width / 2) {
        spring = { index, edge: floor, extreme: bottom, width: box.width, relativeVolume, session: bar.session }
      }
      if (!sos && close > ceiling && direction * bar.open <= ceiling && displacement(bar, bodyMean, direction)) {
        sos = { index, edge: ceiling, width: box.width, relativeVolume, session: bar.session }
      }
    }
  }
}

export function allSignals(bars, info = features(bars)) {
  const output = Object.fromEntries(Object.keys(models).map((name) => [name, []]))
  brooksSignals(bars, info, output)
  breakoutSignals(bars, info, output)
  ictSignals(bars, info, output)
  smcSignals(bars, info, output)
  wyckoffSignals(bars, info, output)
  for (const signals of Object.values(output)) signals.sort((first, second) => first.index - second.index)
  return output
}
