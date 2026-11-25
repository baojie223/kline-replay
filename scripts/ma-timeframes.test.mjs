import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMaMarket, maReplayStart } from '../src/maBacktest.ts'
import { intradayTimestamp, maChartCursor, maFifteenMinuteBars, maFifteenMinuteFrame, overlappingCandles } from '../src/maTimeframes.ts'

const readMarket = (period) => parseMaMarket(
  readFileSync(new URL(`../research/ma-ict/market-${period}.csv`, import.meta.url), 'utf8'), period,
)
const fiveMinutes = readMarket('5m')
const timestamp = (bar) => Date.parse(`${bar.date.replace(' ', 'T')}:00+08:00`)

test('通达信 1 分钟行情与每根 5 分钟线的时间、合约、价格和成交量对齐', () => {
  const minutes = readMarket('1m')
  assert.equal(minutes.length, fiveMinutes.length * 5)

  for (const [index, bar] of fiveMinutes.entries()) {
    const group = minutes.slice(index * 5, index * 5 + 5)
    const end = timestamp(bar)
    for (const [offset, minute] of group.entries()) {
      assert.equal(timestamp(minute), end - (4 - offset) * 60_000, minute.date)
      assert.equal(minute.session, bar.session)
      assert.equal(minute.contract, bar.contract)
    }
    assert.deepEqual([
      group[0].open, Math.max(...group.map(({ high }) => high)), Math.min(...group.map(({ low }) => low)),
      group[4].close, group.reduce((total, { volume }) => total + volume, 0),
    ], [bar.open, bar.high, bar.low, bar.close, bar.volume], bar.date)
  }
})

test('15 分钟线按交易小节聚合，回放和回退只取当时已收盘的 K 线', () => {
  const fifteenMinutes = maFifteenMinuteBars(fiveMinutes)
  assert.equal(fifteenMinutes.length * 3, fiveMinutes.length)
  const start = maReplayStart(fiveMinutes)
  const [first, second, third] = fiveMinutes.slice(start, start + 3)
  const index = maChartCursor(fifteenMinutes, third.date)
  assert.deepEqual(fifteenMinutes[index], {
    ...third,
    open: first.open,
    high: Math.max(first.high, second.high, third.high),
    low: Math.min(first.low, second.low, third.low),
    volume: first.volume + second.volume + third.volume,
  })
  assert.equal(maChartCursor(fifteenMinutes, first.date), index - 1)
  assert.equal(maChartCursor(fifteenMinutes, second.date), index - 1)
  assert.equal(maChartCursor(fifteenMinutes, '2025-11-17 10:40'), index + 12)
  assert.equal(fifteenMinutes[index + 12].date, '2025-11-17 10:15')
  assert.deepEqual(maFifteenMinuteBars([first, { ...second, contract: 'MA605' }, third]), [])
})

test('形成中的 15 分钟线只包含当前回放已揭示的价格和成交量', () => {
  const fifteen = maFifteenMinuteBars(fiveMinutes)
  const start = maReplayStart(fiveMinutes)
  const [first, second, third] = fiveMinutes.slice(start, start + 3)
  const closedIndex = maChartCursor(fifteen, third.date)
  assert.deepEqual(maFifteenMinuteFrame(fiveMinutes, start, fifteen), {
    cursor: closedIndex, forming: { ...first, date: third.date },
  })
  assert.deepEqual(maFifteenMinuteFrame(fiveMinutes, start + 1, fifteen), {
    cursor: closedIndex, forming: {
      ...second, date: third.date, open: first.open, high: Math.max(first.high, second.high),
      low: Math.min(first.low, second.low), volume: first.volume + second.volume,
    },
  })
  assert.deepEqual(maFifteenMinuteFrame(fiveMinutes, start + 2, fifteen), { cursor: closedIndex })
})

test('跨图高亮按实际覆盖时间，排除相邻 K 线、休市空档和未来行情', () => {
  const at = (time) => intradayTimestamp(`2025-11-17 ${time}`)
  const minutes = ['10:10', '10:11', '10:12', '10:13', '10:14', '10:15', '10:31'].map(at)
  const longer = ['10:15', '10:45'].map(at)
  assert.deepEqual(overlappingCandles(minutes, 6, 60, { from: at('10:10'), to: at('10:15') }), { from: 1, to: 5 })
  assert.deepEqual(overlappingCandles(minutes, 3, 60, { from: at('10:10'), to: at('10:15') }), { from: 1, to: 3 })
  assert.deepEqual(overlappingCandles(longer, 1, 900, { from: at('10:30'), to: at('10:31') }), { from: 1, to: 1 })
  assert.equal(overlappingCandles(longer, 1, 900, { from: at('10:15'), to: at('10:20') }), undefined)
})
