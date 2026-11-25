import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceMaManual, maManualMarket, replayMaManual, restoreMaManual, serializeMaManual, stepMaManual } from '../src/maManual.ts'
import { maFifteenMinuteBars, maFifteenMinuteFrame, maFormingFive, maNextChartPoint, maReplayDate } from '../src/maTimeframes.ts'

const day = '2026-08-12'
const at = (minute) => `${day} 09:${String(minute).padStart(2, '0')}`
const minutes = Array.from({ length: 50 }, (_, index) => {
  const minute = index + 1
  return { date: at(minute), tradeDate: day, contract: 'MA609', session: day + ' morning',
    open: 2000, high: minute === 16 || minute === 32 ? 2010 : 2002, low: minute === 22 ? 1980 : 1998, close: 2000, volume: 20 }
})
const bars = Array.from({ length: 10 }, (_, index) => {
  const part = minutes.slice(index * 5, index * 5 + 5)
  return { ...part[4], high: Math.max(...part.map((bar) => bar.high)), low: Math.min(...part.map((bar) => bar.low)), volume: 100 }
})
const market = maManualMarket(bars, minutes)
const start = 2
const entry = (period, minute = 15) => ({ kind: 'open', at: at(minute), side: 'long', lots: 1,
  entry: { price: 2008, type: 'stop' }, period })

test('画线委托只在所属周期收盘后撮合，成交时间和周期随回放保存', () => {
  for (const [period, before, fill] of [
    [1, { cursor: 2 }, { cursor: 2, minute: 1 }],
    [5, { cursor: 2, minute: 4 }, { cursor: 3 }],
    [15, { cursor: 4, minute: 4 }, { cursor: 5 }],
  ]) {
    const session = { start, ...before, commands: [entry(period)] }
    assert.equal(replayMaManual(bars, session, market).pending.period, period)
    const advanced = advanceMaManual(session, bars, fill)
    const restored = restoreMaManual(serializeMaManual(advanced, bars), bars, 0)
    const { position, pending, priceOrderFilled } = replayMaManual(bars, restored, market)
    assert.equal(position.period ?? 5, period)
    assert.equal(position.entryDate ?? bars[position.entryIndex].date, maReplayDate(bars, fill))
    assert.equal(position.entryPrice, 2008)
    assert.equal(pending, undefined)
    assert.equal(priceOrderFilled, true)
  }
})

test('在未收盘的大周期画线时，跳过已经走过一部分的 K 线', () => {
  for (const [period, before, filled] of [[5, 5, 6], [15, 5, 8]]) {
    const session = { start, cursor: before, commands: [entry(period, 16)] }
    assert.equal(replayMaManual(bars, session, market).pending.period, period)
    const { position } = replayMaManual(bars, { ...session, cursor: filled }, market)
    assert.equal(position.entryIndex, filled)
  }
})

test('读入 1 分钟市场后，原有 5 分钟存档的成交和账户结果一致', () => {
  const orders = [entry(undefined), { kind: 'protection', at: at(20), prices: { stop: 1990 } }]
  for (let cursor = start; cursor < bars.length; cursor++) {
    const session = { start, cursor, commands: orders.filter((command) => command.at <= bars[cursor].date) }
    assert.deepEqual(replayMaManual(bars, session, market), replayMaManual(bars, session))
  }
})

test('单独重画止损线可改用该图周期，未改动的止盈保留原撮合周期', () => {
  const commands = [
    { kind: 'open', at: at(15), side: 'long', lots: 1 },
    { kind: 'protection', at: at(20), period: 15, prices: { target: 2008 } },
    { kind: 'protection', at: at(21), period: 1, prices: { target: 2008, stop: 1992 } },
  ]
  const session = { start, cursor: 3, minute: 1, commands }
  assert.equal(replayMaManual(bars, session, market).position.rules.target.period, 15)
  assert.deepEqual(restoreMaManual(serializeMaManual(session, bars), bars, 0), session)
  const filled = replayMaManual(bars, advanceMaManual(session, bars, { cursor: 3, minute: 2 }), market)
  assert.equal(filled.trades[0].exitPeriod, 1)
  assert.equal(filled.trades[0].exitDate, at(22))
  assert.equal(filled.trades[0].reason, 'stop')
  const rewind = stepMaManual(session, bars, -1)
  assert.equal(rewind.minute, undefined)
  assert.equal(replayMaManual(bars, rewind, market).position.stop, undefined)
})

test('分图下一根移动同一回放时钟，形成中的 K 线只累计已揭示的分钟', () => {
  const fifteen = maFifteenMinuteBars(bars)
  const point = maNextChartPoint(bars, fifteen, { cursor: start }, 1)
  assert.deepEqual(point, { cursor: start, minute: 1 })
  assert.equal(maReplayDate(bars, point), at(16))
  assert.deepEqual(maNextChartPoint(bars, fifteen, point, 5), { cursor: 3 })
  assert.deepEqual(maNextChartPoint(bars, fifteen, point, 15), { cursor: 5 })
  assert.deepEqual(maNextChartPoint(bars, fifteen, { cursor: start, minute: 4 }, 1), { cursor: 3 })
  const forming = maFormingFive(minutes, bars[3], 1, 15)
  assert.equal(forming.volume, 20)
  assert.equal(forming.date, at(20))
  const fifteenFrame = maFifteenMinuteFrame(bars, start, fifteen, forming)
  assert.equal(fifteenFrame.forming.volume, 20)
  assert.equal(fifteenFrame.forming.date, at(30))
  assert.equal(fifteenFrame.forming.low, 1998)
})
