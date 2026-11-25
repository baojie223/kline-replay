import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMaMarket, recordMaReplay, withMaRolls } from '../src/maBacktest.ts'

const folder = new URL('../research/ma-ict/', import.meta.url)
const market = (period) => parseMaMarket(readFileSync(new URL('market-' + period + '.csv', folder), 'utf8'), period)
const daily = market('1d')
const minutes = withMaRolls(market('5m'), daily)
const [header, ...rows] = readFileSync(new URL('trades.csv', folder), 'utf8').trimEnd().split(/\r?\n/)
const fields = header.split(',')
const savedTrades = rows.map((row) => {
  const values = row.split(',')
  return Object.fromEntries(fields.map((field, index) => [field, values[index]]))
})

for (const [period, bars, size, net] of [
  ['5m', minutes, 45, -4618.458],
  ['1d', daily, 3, 6785.007],
]) {
  test(period + ' 回放的每笔操作与原回测记录对齐', () => {
    const { trades, actions, frames, start } = recordMaReplay(bars, period)
    const reference = savedTrades.filter((trade) => trade.period === period).map((trade) => [
      trade.contract, trade.direction, trade.signal, trade.entry, Number(trade.entryPrice), trade.exit,
      Number(trade.exitPrice), trade.reason, Number(trade.net),
    ])
    assert.deepEqual(trades.map((trade) => [
      trade.contract, trade.direction, trade.signal, trade.entry, trade.entryPrice, trade.exit, trade.exitPrice,
      trade.reason, Number(trade.net.toFixed(4)),
    ]), reference)

    const orderCount = actions.filter((action) => action.kind === 'order').length
    const canceled = actions.filter((action) => action.kind === 'cancel').length
    assert.equal(orderCount, size + canceled)
    assert.equal(actions.filter((action) => action.kind === 'roll').length, 5)
    assert.ok(actions.every(({ index }) => index >= start))
    assert.equal(frames[start].closed, 0)
    assert.equal(frames.at(-1).closed, size)
    assert.ok(Math.abs(frames.at(-1).realized - net) < 1e-8)
  })
}

test('夜盘属于下一交易日，回退恢复未成交委托和已结束仓位', () => {
  const { actions, bars, start, frames, trades } = recordMaReplay(minutes, '5m')
  assert.equal(bars[start].date, '2025-11-14 21:05')
  assert.equal(bars[start].tradeDate, '2025-11-17')
  const [signal, order, cancel] = actions
  assert.deepEqual([signal.kind, order.kind, cancel.kind], ['signal', 'order', 'cancel'])
  assert.equal(signal.index, order.index)
  assert.equal(frames[signal.index - 1].pending, undefined)
  assert.equal(frames[order.index].pending, order.setup)
  assert.equal(frames[cancel.index - 1].pending, order.setup)
  assert.equal(frames[cancel.index].pending, undefined)
  assert.equal(frames[cancel.index].closed, 0)

  const [first] = trades
  assert.equal(frames[first.entryIndex - 1].position, undefined)
  assert.equal(frames[first.entryIndex].position.fill.price, first.entryPrice)
  assert.equal(frames[first.exitIndex - 1].closed, 0)
  assert.equal(frames[first.exitIndex].position, undefined)
  assert.equal(frames[first.exitIndex].realized, first.net)
})

