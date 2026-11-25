import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ictRetest, ictRetestWindow, ictSetups } from '../src/ict.ts'
import { simulate } from './backtest-ma-ict.mjs'

const { bars } = JSON.parse(readFileSync(new URL('../public/data/159941.json', import.meta.url), 'utf8'))
const historical = ictSetups(bars, 0.001)

test('ICT 多空形态只在 FVG 确认后可见，随后才确认回踩', () => {
  for (const [signal, entry, direction, price] of [
    ['2026-05-19', '2026-05-20', 'short', 1.527],
    ['2026-05-25', '2026-05-26', 'long', 1.621],
  ]) {
    const index = bars.findIndex((bar) => bar.date === signal)
    const entryIndex = bars.findIndex((bar) => bar.date === entry)
    const setup = historical.find((item) => item.index === index)
    assert.equal(setup?.direction, direction)
    assert.equal(setup.entry, price)
    assert.ok(setup.sweep.index < setup.shiftIndex && setup.shiftIndex <= index)
    assert.deepEqual(ictSetups(bars.slice(0, index), 0.001), historical.filter((item) => item.index < index))
    assert.deepEqual(ictSetups(bars.slice(0, index + 1), 0.001).at(-1), setup)
    assert.equal(ictRetest(bars, setup, index), null)
    assert.deepEqual(ictRetest(bars, setup, entryIndex), { kind: 'filled', price, atOpen: false })
  }
})

test('FVG 遇到跨时段或换月时不会把两段行情接成同一形态', () => {
  const index = bars.findIndex((bar) => bar.date === '2026-05-25')
  for (const field of ['segment', 'session']) {
    const sample = bars.map((bar, i) => ({ ...bar, [field]: i < index ? 'first' : 'second' }))
    assert.ok(!ictSetups(sample, 0.001).some((setup) => setup.index === index))
  }
})

const long = {
  direction: 'long', index: 2, shiftIndex: 1,
  sweep: { index: 0, extreme: 91, liquidity: { index: 0, price: 95 }, structure: { index: 0, price: 102 } },
  entry: 100, stop: 90, target: 120, gapLow: 97, gapHigh: 100,
}

function candles(values) {
  return values.map(([open, high, low, close], index) => {
    const date = '2026-03-' + String(index + 1).padStart(2, '0')
    return { date, tradeDate: date, contract: 'MA605', segment: 'MA605', volume: 100, open, high, low, close }
  })
}

test('限价一档穿透才算回踩，跳空越过止损和交易日切换会撤单', () => {
  const sample = candles([
    [100, 105, 99, 101], [103, 112, 103, 109], [108, 110, 100, 107],
    [104, 110, 100, 105], [95, 98, 93, 96], [90, 98, 88, 95],
  ])
  assert.equal(ictRetest(sample, long, 3), null)
  assert.deepEqual(ictRetest(sample, long, 4), { kind: 'filled', price: 95, atOpen: true })
  assert.deepEqual(ictRetest(sample, long, 5), { kind: 'invalidated' })
  sample[3].tradingDay = sample[3].date
  assert.deepEqual(ictRetest(sample, long, 3), { kind: 'expired' })
  const more = [...sample, ...sample]
  assert.deepEqual(ictRetest(more, long, long.index + ictRetestWindow + 1), { kind: 'expired' })
})

const zeroCosts = { intraday: false, feeRate: 0, marketExitTicks: 0 }
const formation = [[100, 105, 99, 101], [103, 112, 103, 109], [108, 110, 100, 107]]

test('回踩当根双触发按止损，缺乏成交顺序时止盈从后续 K 线确认', () => {
  const competing = candles([...formation, [105, 125, 89, 115], [110, 122, 100, 121]])
  const trace = { actions: [], frames: [] }
  const stopped = simulate(competing, { ...zeroCosts, trace }, [long]).trades[0]
  assert.deepEqual(trace.actions.filter((action) => action.index === 3).map((action) => action.kind), ['entry', 'exit'])
  assert.equal(stopped.reason, 'stop')
  assert.equal(stopped.entry, stopped.exit)
  assert.equal(stopped.exitPrice, 90)
  assert.equal(stopped.net, -100)

  const earlyHigh = candles([...formation, [105, 125, 92, 115], [112, 125, 107, 121]])
  const laterTarget = simulate(earlyHigh, zeroCosts, [long]).trades[0]
  assert.equal(laterTarget.reason, 'target')
  assert.equal(laterTarget.exit, earlyHigh[4].date)
  assert.equal(laterTarget.exitPrice, 120)
})

test('日线持仓换月时用旧合约当日开盘退出', () => {
  const sample = candles([...formation, [104, 110, 98, 103], [210, 219, 200, 205]])
  Object.assign(sample[4], { contract: 'MA609', segment: 'MA609', rollFrom: 'MA605', rollExitOpen: 94 })
  const trade = simulate(sample, zeroCosts, [long]).trades[0]
  assert.equal(trade.reason, 'roll')
  assert.equal(trade.contract, 'MA605')
  assert.equal(trade.exitPrice, 94)
  assert.equal(trade.net, -60)
})

test('止损遇到一价 K 线时等待下一根可成交开盘', () => {
  const sample = candles([...formation, [104, 110, 98, 103], [87, 87, 87, 87], [85, 87, 84, 86]])
  const trade = simulate(sample, { ...zeroCosts, marketExitTicks: 1 }, [long]).trades[0]
  assert.equal(trade.reason, 'stop')
  assert.equal(trade.exit, sample[5].date)
  assert.equal(trade.exitPrice, 85)
  assert.equal(trade.net, -160)
})

