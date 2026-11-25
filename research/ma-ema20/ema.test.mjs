import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMaMarket } from '../../src/maBacktest.ts'
import { scenarios, simulate } from '../ma-strategies/backtest.mjs'
import { emaOrders, higherEma20 } from './strategies.mjs'

const day = '2026-11-16'
function bar(time, open, high, low, close, contract = 'MA701') {
  return { date: `${day} ${time}`, tradeDate: day, session: `${day} session`, contract, open, high, low, close, volume: 100 }
}

test('EMA20 strategies and filters only use information through their signal bar', () => {
  const minutes = new URL('../ma-ict/market-5m.csv', import.meta.url)
  const bars = parseMaMarket(readFileSync(minutes, 'utf8'), '5m')
  const full = emaOrders(bars)
  for (const cutoff of [161, 3187, 6913, 11103, bars.length - 1]) {
    const prefix = emaOrders(bars.slice(0, cutoff))
    for (const [name, orders] of Object.entries(full.output)) {
      assert.deepEqual(prefix.output[name], orders.filter((order) => order.index < cutoff), name)
    }
  }
})

test('15-minute EMA waits for the completed bar, skips an incomplete interval and resets on a roll', () => {
  const source = Array.from({ length: 126 }, (_, index) => {
    const minute = 9 * 60 + (index + 1) * 5
    const time = `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`
    return bar(time, 100, 200, 99, index >= 120 ? 200 : 100)
  })
  source[123].contract = source[124].contract = source[125].contract = 'MA705'
  const higher = higherEma20(source)
  assert.equal(higher[118], undefined)
  assert.deepEqual(higher[119], { ema: 100, slope: 0 })
  assert.equal(higher[120], higher[119])
  assert.equal(higher[121], higher[119])
  assert.ok(higher[122].ema > 100)
  assert.equal(higher[125], undefined)
  assert.equal(higherEma20(source.filter((_, index) => index !== 121))[121].ema, 100)
})

test('A fixed EMA target requires enough room at the actual entry reference', () => {
  const order = { index: 0, origin: 0, life: 1, direction: 1, kind: 'market', stop: 95, target: 110, minimumReward: 1 }
  const options = { from: day, through: day, spec: scenarios.base }
  const start = bar('09:05', 99, 102, 96, 100)
  const last = bar('15:00', 108, 110, 107, 108)
  assert.equal(simulate([start, bar('09:10', 104, 112, 103, 110), last], [order], options).trades.length, 0)
  const [trade] = simulate([start, bar('09:10', 102, 112, 101, 110), last], [order], options).trades
  assert.equal(trade.target, 110)
  assert.equal(trade.reason, 'target')
})

test('An EMA recross schedules an exit at the next bar open', () => {
  const input = [
    bar('09:05', 99, 102, 96, 100), bar('09:10', 101, 111, 100, 106), bar('09:15', 105, 106, 98, 99),
    bar('09:20', 97, 100, 96, 99), bar('15:00', 101, 102, 100, 101),
  ]
  const order = { index: 0, origin: 0, life: 1, direction: 1, kind: 'market', stop: 94, target: null }
  const [trade] = simulate(input, [order], {
    from: day, through: day, spec: scenarios.base, exitAtNextOpen: (index) => index === 2,
  }).trades
  assert.equal(trade.reason, 'ema_close')
  assert.equal(trade.exit, input[3].date)
  assert.equal(trade.exitPrice, input[3].open)
  assert.equal(trade.target, null)
})
