import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { maReplayStart, parseMaMarket, withMaRolls } from '../src/maBacktest.ts'
import { newMaManualSession, replayMaManual, restoreMaManual, serializeMaManual, stepMaManual } from '../src/maManual.ts'

function bar(index, options = {}) {
  return {
    date: '2026-08-12 09:' + String((index + 1) * 5).padStart(2, '0'), tradeDate: '2026-08-12', contract: 'MA609',
    open: 2000, high: 2002, low: 1998, close: 2000, volume: 1000, ...options,
  }
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`)
const open = (bars, side = 'long', options = {}) => ({ kind: 'open', at: bars[0].date, side, lots: 1, ...options })

test('甲醇手动下单按下一根开盘成交，并计手数、手续费和滑点', () => {
  const bars = [bar(0), bar(1, { open: 2002, high: 2010, close: 2006 }),
    bar(2, { open: 2010, high: 2011, low: 2008, close: 2009 }), bar(3)]
  const session = { ...newMaManualSession(0), commands: [open(bars, 'long', { lots: 2 })] }
  const submitted = replayMaManual(bars, session)
  assert.equal(submitted.pending.kind, 'open')
  assert.equal(submitted.position, undefined)
  const entry = replayMaManual(bars, { ...session, cursor: 1 })
  assert.equal(entry.position.entryPrice, 2002)
  near(entry.unrealized, 55.996)
  const commands = [...session.commands, { kind: 'close', at: bars[1].date }]
  const { position, trades, realized, unrealized } = replayMaManual(bars, { ...session, cursor: 2, commands })
  assert.equal(position, undefined)
  assert.equal(unrealized, 0)
  assert.equal(trades[0].exitPrice, 2010)
  assert.equal(trades[0].gross, 160)
  assert.equal(trades[0].slippage, 40)
  near(trades[0].fees, 8.024)
  near(realized, 111.976)
})

test('空单触及止盈按对手价买平，开盘越过止盈优先于同根盘中止损', () => {
  const bars = [bar(0), bar(1, { low: 1994, close: 1997 }),
    bar(2, { open: 1990, high: 2005, low: 1988 }), bar(3)]
  const commands = [open(bars, 'short', { stopTicks: 3, targetTicks: 6 })]
  const entry = replayMaManual(bars, { start: 0, cursor: 1, commands })
  const [touched] = entry.trades
  assert.equal(touched.stop, 2003)
  assert.equal(touched.target, 1994)
  assert.equal(touched.reason, 'target')
  assert.equal(touched.exitPrice, 1995)
  assert.equal(touched.slippage, 20)
  near(touched.net, 36.005)

  bars[1] = bar(1, { low: 1995 })
  const { trades: [trade] } = replayMaManual(bars, { start: 0, cursor: 2, commands })
  assert.equal(trade.reason, 'target')
  assert.equal(trade.exitPrice, 1991)
  assert.equal(trade.slippage, 20)
  near(trade.net, 76.009)
})

test('同根盘中双触发时止损优先，一价触发后按下一根可成交开盘止损', () => {
  const bars = [bar(0), bar(1, { low: 1994, high: 2010 }), bar(2), bar(3)]
  const commands = [open(bars, 'long', { stopTicks: 5, targetTicks: 6 })]
  const result = replayMaManual(bars, { start: 0, cursor: 1, commands })
  assert.equal(result.trades[0].reason, 'stop')
  assert.equal(result.trades[0].exitPrice, 1996)
  near(result.maxDrawdown, 53.996)

  bars[1] = bar(1)
  bars[2] = bar(2, { open: 1980, high: 1980, low: 1980, close: 1980 })
  bars[3] = bar(3, { open: 1999 })
  assert.equal(replayMaManual(bars, { start: 0, cursor: 2, commands }).position.deferredExit, 'stop')
  const deferred = replayMaManual(bars, { start: 0, cursor: 3, commands })
  assert.equal(deferred.trades[0].reason, 'stop')
  assert.equal(deferred.trades[0].exitPrice, 2000)
})

test('止盈触发后遇一价 K 线，回落时仍按下一根可成交开盘的对手价平仓', () => {
  const bars = [
    bar(0), bar(1),
    bar(2, { open: 2006, high: 2006, low: 2006, close: 2006 }),
    bar(3, { open: 1999, low: 1990 }),
  ]
  const commands = [open(bars, 'long', { stopTicks: 5, targetTicks: 6 })]
  const waiting = replayMaManual(bars, { start: 0, cursor: 2, commands })
  assert.equal(waiting.position.deferredExit, 'target')
  const [trade] = replayMaManual(bars, { start: 0, cursor: 3, commands }).trades
  assert.equal(trade.reason, 'target')
  assert.equal(trade.exitPrice, 1998)
})

test('换月用旧合约开盘价退出，并撤销旧合约上的待开仓委托', () => {
  const roll = { contract: 'MA610', tradeDate: '2026-08-13', date: '2026-08-12 21:05',
    rollFrom: 'MA609', rollExitOpen: 2007, open: 2400, high: 2409, low: 2398, close: 2405 }
  const bars = [bar(0), bar(1), bar(2, roll)]
  const { trades: [trade] } = replayMaManual(bars, { start: 0, cursor: 2, commands: [open(bars)] })
  assert.equal(trade.reason, 'roll')
  assert.equal(trade.exitPrice, 2007)
  assert.equal(trade.gross, 70)
  const waiting = replayMaManual(bars, {
    start: 0, cursor: 2, commands: [{ ...open(bars), at: bars[1].date }],
  })
  assert.equal(waiting.pending, undefined)
  assert.equal(waiting.position, undefined)
  assert.equal(waiting.trades.length, 0)
})

test('回退恢复当时的挂单，撤回以后发出的委托，刷新后按时间戳恢复', () => {
  const bars = [bar(0), bar(1), bar(2), bar(3)]
  const session = { start: 0, cursor: 2, commands: [open(bars), { kind: 'close', at: bars[1].date }] }
  const raw = serializeMaManual(session, bars)
  assert.deepEqual(restoreMaManual(raw, bars, 0), session)
  const shifted = [{ ...bar(0), date: '2026-08-11 15:00' }, ...bars]
  assert.deepEqual(restoreMaManual(raw, shifted, 1), { ...session, start: 1, cursor: 3 })
  const beforeExit = stepMaManual(session, bars, -1)
  assert.equal(replayMaManual(bars, beforeExit).pending.kind, 'close')
  const beforeEntry = stepMaManual(beforeExit, bars, -1)
  assert.equal(beforeEntry.commands.length, 1)
  assert.equal(replayMaManual(bars, beforeEntry).pending.kind, 'open')
  beforeEntry.commands.push({ kind: 'cancel', at: bars[0].date })
  assert.equal(replayMaManual(bars, stepMaManual(beforeEntry, bars, 1)).position, undefined)
})

test('行情末尾按收盘平仓，一价 K 线上的待成交委托在期末撤销', () => {
  const bars = [bar(0), bar(1), bar(2, { close: 2002 })]
  const session = { start: 0, cursor: 2, commands: [open(bars)] }
  const { trades: [trade] } = replayMaManual(bars, session)
  assert.equal(trade.reason, 'sample_end')
  assert.equal(trade.exitPrice, 2002)

  const locked = bar(2, { high: 2000, low: 2000 })
  const waiting = replayMaManual([bar(0), locked], { ...session, cursor: 1 })
  assert.equal(waiting.pending, undefined)
  assert.equal(waiting.position, undefined)
  assert.equal(waiting.trades.length, 0)
})

test('逐根增量推进与完整重算一致，历史帧保持原有成交', () => {
  const bars = [bar(0), bar(1), bar(2), bar(3)]
  let session = { start: 0, cursor: 0, commands: [open(bars)] }
  const frames = []
  for (let cursor = 0; cursor < bars.length; cursor++) {
    const frame = replayMaManual(bars, session)
    assert.deepEqual(frame, replayMaManual(bars, { ...session }))
    frames.push(frame)
    session = stepMaManual(session, bars, 1)
  }
  assert.equal(frames[1].trades.length, 0)
  assert.equal(frames.at(-1).trades.length, 1)
})

test('内置近一年甲醇 5 分钟数据保留交易日、夜盘和换月价格', () => {
  function load(period) {
    return parseMaMarket(readFileSync(new URL(`../research/ma-ict/market-${period}.csv`, import.meta.url), 'utf8'), period)
  }
  const bars = withMaRolls(load('5m'), load('1d'))
  const start = maReplayStart(bars)
  const sample = bars.slice(start)
  assert.equal(sample.length, 16530)
  assert.equal(new Set(sample.map((item) => item.tradeDate)).size, 242)
  assert.equal(sample[0].date, '2025-11-14 21:05')
  assert.equal(sample[0].tradeDate, '2025-11-17')
  const roll = bars.findIndex((item, index) => index > start && item.contract !== bars[index - 1].contract)
  const { trades: [trade] } = replayMaManual(bars, {
    start: roll - 2, cursor: roll, commands: [{ kind: 'open', side: 'short', lots: 1, at: bars[roll - 2].date }],
  })
  assert.equal(trade.contract, 'MA601')
  assert.equal(trade.reason, 'roll')
  assert.equal(trade.exitPrice, 2068)
})
