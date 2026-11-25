import { closesMaFifteenMinutes } from '../../src/maTimeframes.ts'
import { allSignals, features, front, rear, signal } from '../ma-strategies/strategies.mjs'

export const emaModels = {
  cross: '价格收盘穿越 EMA20',
  cross_exit: '穿越进场、反穿退出',
  cross_retest: '强穿越后首次回踩',
  pullback: '斜率顺势回踩',
  gap20: '20 根未触 EMA 后首次回踩',
  gap20_extreme: '20 根未触 EMA 后回踩、目标前极值',
  pullback_15m: '顺势回踩且 15 分钟 EMA20 同向',
  pullback_limit: '趋势中 EMA20 限价回踩',
  reversion: '平 EMA20 偏离回归',
}

export const filters = {
  ema_pa_bp: { original: 'pa_bp', label: 'PA 突破回踩加 EMA20 顺势' },
  ema_ict_fvg: { original: 'ict_fvg', label: 'ICT MSS/FVG 加 EMA20 顺势' },
  ema_smc_bos: { original: 'smc_bos', label: 'SMC BOS/OB 加 EMA20 顺势' },
  ema_spring: { original: 'wy_spring', label: '维科夫 Spring/UT 加 EMA20 走平', flat: true },
  ema_sos: { original: 'control_sos', label: '维科夫价格回踩加 EMA20 顺势' },
}

const warmup = 40
const slopeThreshold = 0.35
const directions = [1, -1]

// A 15-minute close becomes visible only on the third contiguous 5-minute bar.
export function higherEma20(bars) {
  const known = []
  let closes = []
  let completed
  for (const [index, bar] of bars.entries()) {
    if (bar.contract !== bars[index - 1]?.contract) {
      closes = []
      completed = undefined
    }
    if (closesMaFifteenMinutes(bars[index - 2], bars[index - 1], bar)) {
      const previous = closes.at(-1) ?? bar.close
      closes.push(previous + (bar.close - previous) * 2 / 21)
      if (closes.length >= warmup) completed = { ema: closes.at(-1), slope: closes.at(-1) - closes.at(-4) }
    }
    known.push(completed)
  }
  return known
}

function pastSlope(info, index) {
  return info[index - 1].ema - info[index - 6].ema
}

function reversalBar(bar, direction) {
  const range = bar.high - bar.low
  return direction * (bar.close - bar.open) > 0 && front(bar, direction) - direction * bar.close <= range / 3
}

export function emaOrders(bars) {
  const info = features(bars)
  const higher = higherEma20(bars)
  const output = Object.fromEntries(Object.keys(emaModels).map((name) => [name, []]))
  for (const direction of directions) {
    let away = 0
    let peak = -Infinity
    let issuedLimit = false
    let touch
    let crossing
    for (let index = 1; index < bars.length; index++) {
      const bar = bars[index]
      const previous = bars[index - 1]
      if (info[index].age === 0) {
        away = 0
        peak = -Infinity
        issuedLimit = false
        touch = crossing = undefined
        continue
      }

      const ema = direction * info[index].ema
      const anchor = direction * info[index - 1].ema
      const atr = info[index - 1].atr
      const close = direction * bar.close
      const low = rear(bar, direction)
      const high = front(bar, direction)
      const touched = low <= anchor
      if (bar.session !== previous.session) touch = crossing = undefined

      if (info[index].age >= warmup && atr > 0 && bar.session === previous.session) {
        const slope = pastSlope(info, index)
        const trend = direction * slope >= slopeThreshold * atr
        const reclaim = close >= ema + 0.1 * atr && reversalBar(bar, direction)

        if (crossing && (index - crossing.index > 6 || close <= ema)) crossing = undefined
        if (crossing && low <= anchor + 0.15 * atr && low >= anchor - atr && reclaim) {
          output.cross_retest.push(signal(direction, index, 'stop', direction * (low - 1), {
            entry: direction * (high + 1), reference: direction * anchor, origin: crossing.index,
          }))
          crossing = undefined
        }
        if (close > ema && direction * previous.close <= anchor) {
          const stop = direction * Math.floor(close - 1.5 * atr)
          const plan = signal(direction, index, 'market', stop, { reference: direction * ema })
          output.cross.push(plan)
          output.cross_exit.push({ ...plan, target: null })
          if (close >= ema + 0.5 * atr && direction * (bar.close - bar.open) >= 0.5 * (bar.high - bar.low)) {
            crossing = { index }
          }
        }

        if (touched && away >= 5 && trend) touch = { index, low, peak, away, anchor, atr }
        if (touch) {
          touch.low = Math.min(touch.low, low)
          if (index - touch.index > 2 || touch.low < touch.anchor - 1.25 * touch.atr) touch = undefined
          else if (reclaim) {
            const trigger = high + 1
            const stop = touch.low - 1
            const plan = signal(direction, index, 'stop', direction * stop, {
              entry: direction * trigger, reference: direction * touch.anchor, origin: touch.index,
            })
            output.pullback.push(plan)
            if (higher[index] && direction * higher[index].slope > 0 && direction * (bar.close - higher[index].ema) > 0) {
              output.pullback_15m.push(plan)
            }
            if (touch.away >= 20) {
              output.gap20.push(plan)
              if (touch.peak - trigger >= trigger - stop) {
                output.gap20_extreme.push({ ...plan, target: direction * touch.peak, minimumReward: 1 })
              }
            }
            touch = undefined
          }
        }

        if (!issuedLimit && !touched && away >= 4 && trend && low > ema && low <= ema + 0.75 * atr &&
            close <= ema + 1.5 * atr) {
          const entry = Math.round(ema)
          if (entry < close) {
            output.pullback_limit.push(signal(direction, index, 'limit', direction * (entry - Math.ceil(1.25 * atr)), {
              entry: direction * entry, reference: direction * ema, life: 3,
            }))
            issuedLimit = true
          }
        }

        if (Math.abs(slope) <= slopeThreshold * atr && Math.abs(previous.close - info[index - 1].ema) <= 1.5 * atr &&
            low <= anchor - 1.75 * atr && close <= ema - 0.75 * atr && reversalBar(bar, direction)) {
          const stop = low - 1
          const target = Math.round(ema)
          if (target - close >= close - stop) {
            output.reversion.push(signal(direction, index, 'market', direction * stop, {
              reference: direction * ema, target: direction * target, minimumReward: 1,
            }))
          }
        }
      }

      if (touched) {
        away = 0
        peak = -Infinity
        issuedLimit = false
      } else {
        away++
        peak = Math.max(peak, high)
      }
    }
  }

  const original = allSignals(bars, info)
  const comparators = {}
  for (const [name, { original: source, flat }] of Object.entries(filters)) {
    comparators[name] = original[source].filter(({ index, origin }) => info[flat ? origin : index].age >= warmup)
    output[name] = comparators[name].filter(({ direction, index, origin }) => {
      const referenceIndex = flat ? origin : index
      const slope = pastSlope(info, referenceIndex)
      const minimum = slopeThreshold * info[referenceIndex - 1].atr
      return flat ? Math.abs(slope) <= minimum
        : direction * slope >= minimum && direction * (bars[index].close - info[index].ema) > 0
    })
  }
  for (const plans of Object.values(output)) plans.sort((left, right) => left.index - right.index)
  const exitOnRecross = (index, order) => order.direction * (bars[index].close - info[index].ema) <= 0
  return { output, comparators, exitOnRecross }
}
