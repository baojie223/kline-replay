import assert from 'node:assert/strict'
import test from 'node:test'
import { matchPriceEntry, priceEntry, validPriceEntry } from '../src/entryOrder.ts'
import { advance, amendManualEntry, amendManualProtection, defaultSettings, rewind, startSession, submitManualOrder } from '../src/replay.ts'
import { replayMaManual, restoreMaManual, serializeMaManual, stepMaManual } from '../src/maManual.ts'

const bar = (i, values = {}) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1000, ...values })
const ma = (i, values = {}) => ({ ...bar(i), date: `2026-01-05 09:${String((i + 1) * 5).padStart(2, '0')}`,
  tradeDate: '2026-01-05', contract: 'MA605', open: 2000, high: 2002, low: 1998, close: 2000, ...values })
const etfOrder = (bars, price, protection = {}) => submitManualOrder(startSession(0, defaultSettings), bars, 'buy', 100, 1, 'close', 1,
  protection, priceEntry(price, bars[0].close, 1))

test('Long/short limit and breakout entries trigger at touch and gap fills use open', () => {
  for (const direction of [1, -1]) {
    for (const delta of [-1, 1]) {
      const entry = priceEntry(10 + delta, 10, direction)
      assert.equal(entry.type, delta * direction > 0 ? 'stop' : 'limit')
      assert.equal(matchPriceEntry(bar(0), entry, direction), undefined)
      assert.deepEqual(matchPriceEntry(bar(0, { high: 11, low: 9 }), entry, direction), { price: 10 + delta, intrabar: true })
      assert.deepEqual(matchPriceEntry(bar(0, { open: 10 + delta * 2 }), entry, direction), { price: 10 + delta * 2, intrabar: false })
    }
  }
})

test('An exact entry price must resolve to a positive, safe tick count', () => {
  assert.equal(validPriceEntry({ price: 0.001, type: 'limit' }, 3), true)
  assert.equal(validPriceEntry({ price: 0.0000000001, type: 'limit' }, 3), false)
  assert.equal(validPriceEntry({ price: Number.MAX_SAFE_INTEGER + 1, type: 'stop' }, 0), false)
})

test('ETF price order waits across candles, ignores submit candle, fills once, and rewinds', () => {
  const bars = [bar(0, { low: 8 }), bar(1), bar(2, { low: 9 }), bar(3)]
  const submitted = etfOrder(bars, 9)
  assert.equal(submitted.trades.length, 0)
  const waiting = advance(submitted, bars)
  assert.equal(waiting.trades.length, 0)
  assert.equal(waiting.pending.entry.price, 9)
  const filled = advance(waiting, bars)
  assert.equal(filled.trades.length, 1)
  assert.equal(filled.trades[0].price, 9)
  assert.equal(filled.pending, null)
  assert.equal(rewind(filled).pending.entry.price, 9)
  assert.equal(advance(filled, bars).trades.length, 1)
})

test('ETF amendments persist, cancellation removes order, and protection uses the planned entry', () => {
  const bars = [bar(0), bar(1), bar(2)]
  let session = etfOrder(bars, 9, { stop: 8, target: 9.5 })
  assert.equal(session.pending.entry.price, 9)
  session = amendManualProtection(session, bars, { stop: 8.5, target: 9.8 })
  assert.equal(session.pending.protection.target, 9.8)
  session = amendManualEntry(session, bars, 9.2)
  assert.equal(session.pending.entry.price, 9.2)
  assert.equal(session.pending.entry.type, 'limit')
  assert.equal(amendManualEntry(session, bars, 9.9).pending.entry.price, 9.2)
  assert.equal(amendManualEntry(session, bars, undefined).pending, null)
  assert.equal(advance(advance(session, bars), bars).pending, null)
})

test('ETF intrabar entry does not claim earlier target high; simultaneous stop stays conservative', () => {
  const bars = [bar(0), bar(1, { high: 11, low: 9, close: 9.5 }), bar(2)]
  let session = advance(etfOrder(bars, 9, { target: 10.5, stop: 8.5 }), bars)
  assert.equal(session.trades.length, 1)
  session = advance(etfOrder([bar(0), bar(1, { high: 11, low: 8, close: 9.5 }), bar(2)], 9, { target: 10.5, stop: 8.5 }),
    [bar(0), bar(1, { high: 11, low: 8, close: 9.5 }), bar(2)])
  assert.equal(session.trades[1].price, 8.501)
  assert.ok(session.trades[1].stopLossRate !== undefined)
})

test('MA short breakout waits, amendments survive save/reload, then fill only once', () => {
  const bars = [ma(0), ma(1), ma(2, { low: 1980 }), ma(3)]
  const commands = [{ kind: 'open', side: 'short', lots: 1, entry: priceEntry(1990, 2000, -1), protection: {}, at: bars[0].date },
    { kind: 'entry', price: 1985, at: bars[1].date }]
  const session = { start: 0, cursor: 1, commands }
  assert.equal(replayMaManual(bars, session).pending.entry.price, 1985)
  const restored = restoreMaManual(serializeMaManual(session, bars), bars, 0)
  assert.deepEqual(restored, session)
  const filled = replayMaManual(bars, stepMaManual(restored, bars, 1))
  assert.equal(filled.position.entryPrice, 1985)
  assert.equal(filled.pending, undefined)
  assert.equal(replayMaManual(bars, stepMaManual(restored, bars, -1)).pending.entry.price, 1990)
})

test('MA limit entry validates brackets around entry, with no retroactive take profit', () => {
  const bars = [ma(0), ma(1, { high: 2010, low: 1990, close: 1992 }), ma(2)]
  const commands = [{ kind: 'open', side: 'long', lots: 1, entry: priceEntry(1990, 2000, 1),
    protection: { stop: 1980, target: 1995 }, at: bars[0].date }]
  const result = replayMaManual(bars, { start: 0, cursor: 1, commands })
  assert.equal(result.position.entryPrice, 1990)
  assert.equal(result.trades.length, 0)
})

test('MA pending cancels on command, roll and sample end, and waits on locked/no-volume bars', () => {
  const bars = [ma(0), ma(1, { open: 1990, high: 1990, low: 1990, close: 1990 }),
    ma(2, { low: 1990, volume: 0 }), ma(3)]
  const command = { kind: 'open', side: 'long', lots: 1, entry: priceEntry(1990, 2000, 1), protection: {}, at: bars[0].date }
  assert.ok(replayMaManual(bars, { start: 0, cursor: 2, commands: [command] }).pending)
  assert.equal(replayMaManual(bars, { start: 0, cursor: 3, commands: [command] }).pending, undefined)
  assert.equal(replayMaManual(bars, { start: 0, cursor: 1, commands: [command, { kind: 'cancel', at: bars[1].date }] }).pending, undefined)
  bars[2] = ma(2, { contract: 'MA609' })
  assert.equal(replayMaManual(bars, { start: 0, cursor: 2, commands: [command] }).pending, undefined)
})
