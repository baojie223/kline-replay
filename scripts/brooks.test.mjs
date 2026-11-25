import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { brooksEntries, brooksHighTwos } from '../src/brooks.ts'

const { bars: marketBars } = JSON.parse(readFileSync(new URL('../public/data/159941.json', import.meta.url), 'utf8'))

function sample(pullback) {
  const trend = Array.from({ length: 25 }, (_, index) => {
    const close = 1000 + index * 20
    return [close - 20, close + 10, close]
  })
  return [...trend, ...pullback].map(([low, high, close], index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close / 1000, high: high / 1000, low: low / 1000, close: close / 1000, volume: 10000,
  }))
}

test('H2 等第二段回调结束并突破一档，回退后移除触发标记', () => {
  const bars = sample([
    [1440, 1470, 1450], // 第一段回调
    [1450, 1478, 1470], // H1
    [1445, 1474, 1450], // 第二段回调
    [1448, 1474, 1469], // 触及信号高点
    [1460, 1475, 1471], // 突破一档
  ])
  const confirmed = brooksHighTwos(bars, 29)
  assert.deepEqual(confirmed, [{ date: bars[29].date, signalDate: bars[28].date, trigger: 1.475 }])
  assert.deepEqual(brooksHighTwos(bars, 28), [])
  assert.deepEqual(brooksHighTwos(bars, 29), confirmed)
})

test('H1 后的外包线需要下一根确认 H2', () => {
  const bars = sample([
    [1440, 1470, 1450],
    [1450, 1478, 1470],
    [1445, 1481, 1475],
    [1455, 1482, 1478],
  ])
  assert.deepEqual(brooksHighTwos(bars, 27), [])
  assert.deepEqual(brooksHighTwos(bars, 28), [{ date: bars[28].date, signalDate: bars[27].date, trigger: 1.482 }])
})

test('H1 已突破回调起点时重新计数', () => {
  const bars = sample([
    [1440, 1470, 1450],
    [1450, 1492, 1485],
    [1445, 1474, 1450],
    [1460, 1475, 1471],
  ])
  assert.deepEqual(brooksHighTwos(bars, 28), [])
})

for (const [pattern, date, signalDate, trigger, evidenceCount] of [
  ['wedgeFlag', '2026-11-11', '2026-11-10', 1.634, 3],
  ['wedgeReversal', '2026-04-23', '2026-04-22', 1.409, 4],
  ['range', '2026-01-23', '2026-01-22', 1.411, 4],
]) {
  test(`${pattern} 到触发日才出现，之后的行情不改变标记`, () => {
    const cursor = marketBars.findIndex((bar) => bar.date === date)
    const entries = brooksEntries(marketBars, cursor)
    const entry = entries.find((item) => item.date === date && item.pattern === pattern)
    assert.ok(entry)
    assert.equal(entry.signalDate, signalDate)
    assert.equal(entry.trigger, trigger)
    assert.equal(entry.evidence.length, evidenceCount)
    assert.ok(entry.evidence.every((point) => point.date < signalDate))
    assert.deepEqual(brooksEntries(marketBars, cursor - 1), entries.filter((item) => item.date < date))
    assert.deepEqual(brooksEntries(marketBars, marketBars.length - 1).filter((item) => item.date <= date), entries)
  })
}

test('区间下沿跌破后收回才标记，次日跳空失守取消', () => {
  const cursor = marketBars.findIndex((bar) => bar.date === '2026-01-23')
  const bars = marketBars.slice(0, cursor + 1)
  bars[cursor - 1] = { ...bars[cursor - 1], low: 1.382 }
  const entry = brooksEntries(bars, cursor).find((item) => item.date === bars[cursor].date && item.pattern === 'range')
  assert.ok(entry?.detail.includes('跌破后收回'))

  bars[cursor] = { ...bars[cursor], open: 1.38, low: 1.38 }
  assert.ok(!brooksEntries(bars, cursor).some((item) => item.date === bars[cursor].date && item.pattern === 'range'))
})
