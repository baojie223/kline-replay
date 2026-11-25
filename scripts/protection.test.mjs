import assert from 'node:assert/strict'
import test from 'node:test'
import { advance, amendManualProtection, cancelManualProtection, defaultSettings, rewind, startSession, submitManualOrder } from '../src/replay.ts'
import { replayMaManual, restoreMaManual, serializeMaManual, stepMaManual } from '../src/maManual.ts'
import { matchMarketProtection, protectionError } from '../src/protection.ts'

const etfBar = (day, values = {}) => ({ date: `2026-01-0${day}`, open: 1, high: 1.02, low: 0.98, close: 1, volume: 1000, ...values })
const maBar = (minute, values = {}) => ({ date: `2026-01-05 09:${minute}`, tradeDate: '2026-01-05', contract: 'MA605',
  open: 2000, high: 2002, low: 1998, close: 2000, volume: 1000, ...values })

test('Protection offsets from the crossing direction for long and short orders', () => {
  const up = maBar('05', { open: 1500, high: 2000, low: 1500, close: 2000 })
  const down = maBar('10', { open: 1500, high: 1500, low: 1000, close: 1000 })
  assert.equal(matchMarketProtection(up, { target: 2000 }, 1, 0).price, 1999)
  assert.equal(matchMarketProtection(up, { stop: 2000 }, -1, 0).price, 1999)
  assert.equal(matchMarketProtection(down, { target: 1000 }, -1, 0).price, 1001)
  assert.equal(matchMarketProtection(down, { stop: 1000 }, 1, 0).price, 1001)
})

test('ETF fixed prices override rates and close entries do not use earlier intraday touches', () => {
  const bars = [etfBar(1, { high: 1.2, low: 0.8 }), etfBar(2, { high: 1.06 }), etfBar(3)]
  const start = startSession(0, defaultSettings)
  const entry = submitManualOrder(start, bars, 'buy', 1000, NaN, 'close', NaN, { target: 1.05, stop: 0.95 })
  assert.equal(submitManualOrder(start, bars, 'buy', 1000, NaN, 'open').pending, null)
  assert.equal(entry.trades.length, 1)
  assert.equal(entry.manualTakeProfit.price, 1.05)
  assert.equal(entry.manualStopLoss.price, 0.95)
  const exit = advance(entry, bars)
  assert.equal(exit.trades[1].price, 1.049)
  assert.equal(exit.shares, 0)
})

test('ETF amended protection is effective next candle and rewind restores prior prices', () => {
  const bars = [etfBar(1), etfBar(2, { high: 1.1 }), etfBar(3, { high: 1.08 })]
  const entry = submitManualOrder(startSession(0, defaultSettings), bars, 'buy', 1000, 1, 'close', 1, { target: 1.2, stop: 0.9 })
  const frame = advance(entry, bars)
  const changed = amendManualProtection(frame, bars, { target: 1.07, stop: 0.95 })
  assert.equal(changed.trades.length, 1)
  assert.equal(frame.manualTakeProfit.price, 1.2)
  assert.equal(advance(changed, bars).trades[1].price, 1.069)
  assert.equal(rewind(changed).manualTakeProfit.price, 1.2)
})

test('ETF fixed stop uses the opening quote as reference when the entry gaps below it', () => {
  const bars = [etfBar(1), etfBar(2, { open: 0.9, high: 0.92, low: 0.85, close: 0.91 })]
  const order = submitManualOrder(startSession(0, defaultSettings), bars, 'buy', 1000, 1, 'open', 1, { target: 1.05, stop: 0.95 })
  const filled = advance(order, bars)
  assert.equal(filled.trades[0].price, 0.9)
  assert.equal(filled.trades[1].price, 0.901)
})

test('ETF locked protection stays triggered until the next tradable open', () => {
  const bars = [
    etfBar(1),
    etfBar(2, { open: 0.9, high: 0.9, low: 0.9, close: 0.9 }),
    etfBar(3, { open: 0.99, low: 0.99 }),
  ]
  const held = submitManualOrder(startSession(0, defaultSettings), bars, 'buy', 1000, 1, 'close', 1, { stop: 0.96, target: 1.05 })
  const waiting = advance(held, bars)
  assert.equal(waiting.manualStopLoss.triggered, true)
  assert.equal(waiting.manualTakeProfit, null)
  assert.equal(waiting.trades.length, 1)
  assert.equal(cancelManualProtection(held, 'stop').manualStopLoss, null)
  const afterCancel = cancelManualProtection(waiting, 'stop')
  assert.equal(afterCancel, waiting)
  const sold = advance(afterCancel, bars)
  assert.equal(sold.trades[1].price, 0.991)
  assert.equal(sold.shares, 0)
  assert.equal(rewind(sold).manualStopLoss.triggered, true)
})

test('ETF supports pending amendments, deleting protection, and fixed prices after partial exits', () => {
  const bars = [etfBar(1), etfBar(2), etfBar(3)]
  let session = submitManualOrder(startSession(0, defaultSettings), bars, 'buy', 1000, 1, 'open', 1, { target: 1.05, stop: 0.95 })
  session = amendManualProtection(session, bars, { target: 1.08, stop: 0.9 })
  session = advance(session, bars)
  session = submitManualOrder(session, bars, 'sell', 500, 1, 'open')
  session = advance(session, bars)
  assert.equal(session.shares, 500)
  assert.equal(session.manualTakeProfit.price, 1.08)
  assert.equal(session.manualStopLoss.price, 0.9)
  session = amendManualProtection(session, bars, {})
  assert.equal(session.manualTakeProfit, null)
  assert.equal(session.manualStopLoss, null)
})

test('ETF stop amendments preserve the resting target when an untraded bar closes at its price', () => {
  const entry = submitManualOrder(startSession(0, defaultSettings), [etfBar(1), etfBar(2)], 'buy', 1000, 1, 'close')
  const target = entry.manualTakeProfit
  const bars = [etfBar(1), etfBar(2, { close: target.price, volume: 0 })]
  const held = advance(entry, bars)
  const amended = amendManualProtection(held, bars, { target: target.price, stop: 1.005 })
  assert.equal(amended.manualStopLoss.price, 1.005)
  assert.equal(amended.manualTakeProfit, target)
})

test('MA long and short use absolute prices, retain amendments across reload, and rewind them', () => {
  const bars = [maBar('05'), maBar('10'), maBar('15', { low: 1980 }), maBar('20')]
  const commands = [{ kind: 'open', at: bars[0].date, side: 'short', lots: 1, protection: { stop: 2020, target: 1970 } },
    { kind: 'protection', at: bars[1].date, prices: { stop: 2010, target: 1990 } }]
  const session = { start: 0, cursor: 1, commands }
  assert.equal(replayMaManual(bars, session).position.target, 1990)
  const restored = restoreMaManual(serializeMaManual(session, bars), bars, 0)
  assert.deepEqual(restored, session)
  const exit = replayMaManual(bars, stepMaManual(restored, bars, 1)).trades[0]
  assert.equal(exit.reason, 'target')
  assert.equal(exit.exitPrice, 1991)
  const back = replayMaManual(bars, stepMaManual(restored, bars, -1))
  assert.equal(back.pending.protection.target, 1970)
})

test('MA amendments never trigger on an earlier part of the same candle, deletion persists', () => {
  const bars = [maBar('05'), maBar('10', { high: 2010, low: 1990 }), maBar('15'), maBar('20')]
  const commands = [{ kind: 'open', at: bars[0].date, side: 'long', lots: 1, protection: { stop: 1980, target: 2020 } },
    { kind: 'protection', at: bars[1].date, prices: { stop: 1995, target: 2005 } }]
  assert.equal(replayMaManual(bars, { start: 0, cursor: 1, commands }).trades.length, 0)
  commands.push({ kind: 'protection', at: bars[1].date, prices: {} })
  const result = replayMaManual(bars, { start: 0, cursor: 2, commands })
  assert.equal(result.position.stop, undefined)
  assert.equal(result.position.target, undefined)
})

test('MA legacy saves retain their limit fills and resume with market protection', () => {
  const bars = [
    maBar('05'),
    maBar('10', { high: 2005, close: 2005 }),
    maBar('15', { open: 2004, high: 2005, low: 1999 }),
  ]
  const commands = [
    { kind: 'open', at: bars[0].date, side: 'long', lots: 1, protection: { stop: 1990, target: 2005 } },
    { kind: 'protection', at: bars[1].date, prices: { stop: 2001, target: 2005 } },
  ]
  const raw = JSON.stringify({ start: bars[0].date, cursor: bars[1].date, commands })
  const session = restoreMaManual(raw, bars, 0)
  assert.equal(session.legacyProtectionThrough, bars[1].date)
  assert.deepEqual(restoreMaManual(serializeMaManual(session, bars), bars, 0), session)
  const { position } = replayMaManual(bars, session)
  assert.equal(position.stop, 2001)
  assert.equal(position.target, 2005)
  const [trade] = replayMaManual(bars, stepMaManual(session, bars, 1)).trades
  assert.equal(trade.reason, 'stop')
  assert.equal(trade.exitPrice, 2002)
  const rewound = stepMaManual(session, bars, -1)
  assert.equal(rewound.legacyProtectionThrough, bars[0].date)
  const [changed] = replayMaManual(bars, stepMaManual(rewound, bars, 1)).trades
  assert.equal(changed.reason, 'target')
  assert.equal(changed.exitPrice, 2004)
})

test('MA version 2 preserves prior fills and applies the corrected quote after rewind', () => {
  const bars = [maBar('05'), maBar('10', { low: 1990 }), maBar('15')]
  const commands = [{ kind: 'open', at: bars[0].date, side: 'long', lots: 1, protection: { stop: 1995 } }]
  const raw = JSON.stringify({ version: 2, start: bars[0].date, cursor: bars[1].date, commands })
  const saved = restoreMaManual(raw, bars, 0)
  assert.equal(replayMaManual(bars, saved).trades[0].exitPrice, 1994)
  const rewound = stepMaManual(saved, bars, -1)
  assert.equal(replayMaManual(bars, stepMaManual(rewound, bars, 1)).trades[0].exitPrice, 1996)
})

test('MA gap beyond fixed target takes the opposite quote at the open, and pending amendments apply', () => {
  const bars = [maBar('05'), maBar('10', { open: 2030, high: 2032, low: 2028, close: 2030 }), maBar('15')]
  const commands = [{ kind: 'open', at: bars[0].date, side: 'long', lots: 1, protection: { stop: 1980, target: 2040 } },
    { kind: 'protection', at: bars[0].date, prices: { stop: 1980, target: 2020 } }]
  const trade = replayMaManual(bars, { start: 0, cursor: 1, commands }).trades[0]
  assert.equal(trade.entryPrice, 2030)
  assert.equal(trade.exitPrice, 2029)
})

test('Protection validates tick precision and long/short sides while allowing a profitable trailing stop', () => {
  assert.ok(protectionError({ target: 0.9 }, 1))
  assert.ok(protectionError({ stop: 1999 }, 2000, -1, 0))
  assert.ok(protectionError({ stop: 1999.5 }, 2000, 1, 0))
  assert.ok(protectionError({ target: NaN }, 1))
  assert.equal(protectionError({ stop: 1.05, target: 1.2 }, 1.1), '')
})
