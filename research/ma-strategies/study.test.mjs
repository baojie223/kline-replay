import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { maBaseCosts, maWindow, parseMaMarket, simulate as simulateIct } from '../../src/maBacktest.ts'
import { scenarios, simulate } from './backtest.mjs'
import { allSignals } from './strategies.mjs'

const input = new URL('../ma-ict/market-5m.csv', import.meta.url)
const bars = parseMaMarket(readFileSync(input, 'utf8'), '5m')
const plans = allSignals(bars)

test('Each signal is the same when the input stops at a historical close', () => {
  const cutoffs = [137, 914, 3038, 5913, 11149, 15101, bars.length - 1]
  for (const cutoff of cutoffs) {
    const prefix = allSignals(bars.slice(0, cutoff))
    for (const [name, signals] of Object.entries(plans)) {
      assert.deepEqual(prefix[name], signals.filter((signal) => signal.index < cutoff), name)
    }
  }
})

test('The comparison reproduces the original ICT trades and drawdown on the same snapshot', () => {
  const original = simulateIct(bars, { intraday: true, ...maBaseCosts })
  const result = simulate(bars, plans.ict_fvg, { ...maWindow, spec: scenarios.base })
  const fills = (trades) => trades.map(({ direction, entry, entryPrice, exit, exitPrice, reason, net }) =>
    ({ direction, entry, entryPrice, exit, exitPrice, reason, net }))
  assert.deepEqual(fills(result.trades), fills(original.trades))
  assert.equal(result.maxDrawdown, original.maxDrawdown)
})

function fixture(kind, low, spec = scenarios.base) {
  const day = '2026-01-05'
  const bar = (time, open, high, low, close) => ({
    date: day + ' ' + time, tradeDate: day, contract: 'MA605', open, high, low, close, volume: 100,
  })
  const input = [bar('09:05', 100, 102, 100, 100), bar('09:10', 100, 113, low, 101), bar('15:00', 101, 102, 100, 101)]
  const order = { index: 0, origin: 0, life: 1, direction: 1, kind, entry: kind === 'limit' ? 99 : 102, stop: 97 }
  return simulate(input, [order], { from: day, through: day, spec }).trades[0]
}

test('An intrabar target can follow a stop entry even if the candle closes below the target', () => {
  const trade = fixture('stop', 99)
  assert.equal(trade.reason, 'target')
  assert.equal(trade.exitPrice, 112, '2R from the stop-entry price to the protective stop')
})

test('An intrabar limit target requires a later price, and the stop wins an ambiguous collision', () => {
  assert.equal(fixture('limit', 98).reason, 'day_end')
  assert.equal(fixture('limit', 97).reason, 'stop')
  assert.equal(fixture('limit', 97, scenarios.targetFirst).reason, 'target')
})
