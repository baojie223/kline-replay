import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  advance, canRewind, defaultManualTakeProfitRate, defaultSettings, equity, markReversal, orderError, resolveDate,
  rewind, startSession, submitManualOrder, takeProfitResults, validExitRate,
} from '../src/replay.ts'

const { bars } = JSON.parse(readFileSync(new URL('../public/data/159941.json', import.meta.url), 'utf8'))
const previousSettings = { ...defaultSettings, commission: 0.03, minimum: 5 }

test('非交易日顺延，订单使用下一交易日开盘价', () => {
  const index = resolveDate(bars, '2025-04-05')
  assert.equal(bars[index].date, '2025-04-07')
  const session = startSession(index, previousSettings)
  const updated = advance({ ...session, pending: { side: 'buy', quantity: 1000, date: bars[index].date } }, bars)
  assert.equal(bars[updated.cursor].date, '2025-04-08')
  assert.equal(updated.trades[0].price, bars[index + 1].open)
  assert.equal(updated.trades[0].fee, 5)
  assert.equal(updated.cash, 100000 - 1000 * bars[index + 1].open - 5)
  assert.equal(updated.shares, 1000)
  assert.equal(updated.pending, null)
})

test('部分卖出按含佣金的持仓均价结算，账户按收盘计价', () => {
  const sample = [
    { date: '2025-01-02', open: 1, close: 1, high: 1.03, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 1, close: 0.99, high: 1.01, low: 0.98, volume: 10000 },
    { date: '2025-01-06', open: 1.05, close: 1.03, high: 1.08, low: 1.02, volume: 10000 },
  ]
  const session = startSession(0, { ...previousSettings, capital: 10000 })
  const bought = advance({ ...session, pending: { side: 'buy', quantity: 1000, date: sample[0].date } }, sample)
  assert.equal(equity(bought, 0.99), 9985)
  assert.equal(bought.maxDrawdown, 0.0015)
  const sold = advance({ ...bought, pending: { side: 'sell', quantity: 500, date: sample[1].date } }, sample)
  assert.equal(sold.cost, 502.5)
  assert.equal(sold.trades[1].realized, 17.5)
  assert.equal(equity(sold, 1.03), 10030)
  assert.equal(advance(sold, sample), sold)
})

test('资金不足或一字涨停时委托失效，且原持仓和现金保持一致', () => {
  const index = resolveDate(bars, '2025-04-08')
  const session = startSession(index, { ...defaultSettings, capital: 10 })
  assert.match(orderError(session, 'sell', 100, false), /超过/)
  assert.match(orderError(session, 'buy', 150, false), /整数倍/)
  const pending = { side: 'buy', quantity: 100, date: bars[index].date }
  const rejected = advance({ ...session, pending }, bars)
  assert.match(rejected.message, /现金不足/)
  assert.equal(rejected.cash, 10)
  assert.equal(rejected.trades.length, 0)
  assert.equal(rejected.pending, null)

  const limit = Math.round(bars[index].close * 1100) / 1000
  const locked = { ...bars[index + 1], open: limit, high: limit, low: limit, close: limit }
  const filled = advance({ ...startSession(0, defaultSettings), pending }, [bars[index], locked])
  assert.match(filled.message, /一字涨跌停/)
  assert.equal(filled.shares, 0)
})

test('从标记日累计阳线，第二根收盘买入，随后以含双边佣金的净收益目标止盈', () => {
  const sample = [
    { date: '2025-01-02', open: 0.99, close: 1, high: 1.02, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 1.01, close: 1, high: 1.05, low: 0.98, volume: 10000 },
    { date: '2025-01-06', open: 0.99, close: 1, high: 1.05, low: 0.98, volume: 10000 },
    { date: '2025-01-07', open: 1.01, close: 1.01, high: 1.02, low: 1, volume: 10000 },
    { date: '2025-01-08', open: 1.015, close: 1.02, high: 1.021, low: 1.01, volume: 10000 },
  ]
  const marked = markReversal(startSession(0, previousSettings), sample[0], {
    quantity: 1000, entry: 'close', target: 'net',
  }, false)
  assert.equal(marked.strategy.bullish, 1)
  const waiting = advance(marked, sample)
  assert.equal(waiting.strategy.bullish, 1)
  assert.equal(waiting.trades.length, 0)
  const bought = advance(waiting, sample)
  assert.equal(bought.trades.length, 1)
  assert.equal(bought.trades[0].price, 1)
  assert.equal(bought.strategy.targetPrice, 1.021)
  assert.equal(advance(bought, sample).strategy.phase, 'holding')
  const sold = advance(advance(bought, sample), sample)
  assert.equal(sold.shares, 0)
  assert.equal(sold.strategy, null)
  assert.equal(sold.trades[1].price, 1.021)
  assert.equal(sold.trades[1].realized, 11)
  assert.ok(sold.trades[1].reversal.netReturn >= 0.01)
  assert.equal(sold.trades[1].reversal.markDate, sample[0].date)
  assert.equal(sold.trades[1].reversal.signalDate, sample[2].date)
})

test('万 0.5 双边无最低收费，九档按已回放行情持续独立跟踪', () => {
  const sample = [
    { date: '2025-01-02', open: 0.99, close: 1, high: 1, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 0.99, close: 1, high: 1.06, low: 0.98, volume: 10000 },
    { date: '2025-01-06', open: 1.012, close: 1.02, high: 1.027, low: 1.012, volume: 10000 },
    { date: '2025-01-07', open: 1.055, close: 1.06, high: 1.06, low: 1.05, volume: 10000 },
  ]
  const marked = markReversal(startSession(0, defaultSettings), sample[0], {
    quantity: 10000, entry: 'close', target: 'net',
  }, false)
  const bought = advance(marked, sample)
  assert.equal(bought.trades[0].fee, 0.50)
  const [{ alternatives: entryDay }] = takeProfitResults(bought.trades, bought.settings, sample, bought.cursor)
  assert.deepEqual(entryDay.map(({ rate }) => rate), [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5])
  assert.ok(entryDay.every(({ exit }) => !exit), '收盘买入不能使用入场日最高价')

  const sold = advance(bought, sample)
  assert.equal(sold.strategy, null)
  assert.equal(sold.trades[1].fee, 0.51)
  const [{ alternatives: afterSell }] = takeProfitResults(sold.trades, sold.settings, sample, sold.cursor)
  assert.equal(afterSell[0].price, 1.011)
  assert.equal(afterSell[0].exit.profit, 118.99)
  assert.equal(afterSell[3].exit.price, 1.026)
  assert.equal(afterSell[4].exit, null)
  assert.equal(afterSell[8].exit, null)

  const later = advance(sold, sample)
  const [{ alternatives: settled }] = takeProfitResults(later.trades, later.settings, sample, later.cursor)
  assert.equal(settled[0].exit.date, '2025-01-06')
  assert.equal(settled[8].price, 1.051)
  assert.equal(settled[8].exit.price, 1.055)
  assert.equal(settled[8].exit.days, 2)
  assert.ok(settled[8].exit.netReturn > 0.05)
})

test('可在确认后次日开盘买入并当日触发止盈；跳空越过已有止盈单时按开盘卖出', () => {
  const sample = [
    { date: '2025-01-02', open: 1, close: 1.01, high: 1.02, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 1.01, close: 1.02, high: 1.04, low: 1, volume: 10000 },
    { date: '2025-01-06', open: 1.03, close: 1.04, high: 1.045, low: 1.02, volume: 10000 },
  ]
  const session = startSession(0, { ...defaultSettings, minimum: 0 })
  const strategy = { quantity: 1000, entry: 'open', target: 'price' }
  const signaled = advance(markReversal(session, sample[0], strategy, false), sample)
  assert.equal(signaled.strategy.phase, 'entry')
  assert.equal(signaled.trades.length, 0)
  const closed = advance(signaled, sample)
  assert.deepEqual(closed.trades.map((trade) => [trade.side, trade.price, trade.fillDate]), [
    ['buy', 1.03, '2025-01-06'], ['sell', 1.041, '2025-01-06'],
  ])
  const marked = markReversal(session, sample[0], { ...strategy, entry: 'close' }, false)
  const gapOpen = advance(advance(marked, sample), [
    ...sample.slice(0, 2), { ...sample[2], open: 1.04 },
  ])
  assert.equal(gapOpen.trades[1].price, 1.04)
})

test('手动买入按设置挂净收益止盈，触价才卖出，可以在买入日成交', () => {
  const sample = [
    { date: '2025-01-02', open: 1, close: 1, high: 1.01, low: 0.99, volume: 10000 },
    { date: '2025-01-03', open: 1, close: 1.005, high: 1.009, low: 0.99, volume: 10000 },
    { date: '2025-01-06', open: 1.015, close: 1.016, high: 1.019, low: 1.014, volume: 10000 },
    { date: '2025-01-07', open: 1.03, close: 1.03, high: 1.05, low: 1.025, volume: 10000 },
  ]
  assert.equal(defaultManualTakeProfitRate, 1)
  assert.ok(validExitRate(1) && validExitRate(2.5) && validExitRate(10))
  assert.ok(!validExitRate(0.99) && !validExitRate(10.01) && !validExitRate(NaN))
  const session = {
    ...startSession(0, defaultSettings),
    pending: { side: 'buy', quantity: 1000, date: sample[0].date, takeProfitRate: 2.5 },
  }
  const bought = advance(session, sample)
  assert.equal(bought.manualTakeProfit.price, 1.026)
  assert.equal(bought.trades[0].fee, 0.05)
  assert.equal(bought.trades.length, 1)
  const waiting = advance(bought, sample)
  assert.equal(waiting.shares, 1000)
  const sold = advance(waiting, sample)
  assert.equal(sold.manualTakeProfit, null)
  assert.equal(sold.shares, 0)
  assert.equal(sold.trades[1].price, 1.029)
  assert.equal(sold.trades[1].realized, 28.9)

  const sameDay = advance(session, [sample[0], { ...sample[1], high: 1.031 }])
  assert.equal(sameDay.trades[1].price, 1.025)
  assert.equal(sameDay.trades[1].fillDate, sameDay.trades[0].fillDate)
})

test('手动加仓重算全仓目标，开盘减仓后只对剩余份额执行止盈', () => {
  const sample = [
    { date: '2025-01-02', open: 1, close: 1, high: 1.01, low: 0.99, volume: 10000 },
    { date: '2025-01-03', open: 1, close: 1.005, high: 1.009, low: 0.99, volume: 10000 },
    { date: '2025-01-06', open: 1.02, close: 1.021, high: 1.035, low: 1.018, volume: 10000 },
    { date: '2025-01-07', open: 1.03, close: 1.06, high: 1.07, low: 1.027, volume: 10000 },
  ]
  const buy = (session, takeProfitRate) => advance({
    ...session, pending: { side: 'buy', quantity: 1000, date: sample[session.cursor].date, takeProfitRate },
  }, sample)
  const first = buy(startSession(0, defaultSettings), 10)
  const added = buy(first, 5)
  assert.equal(added.shares, 2000)
  assert.equal(added.manualTakeProfit.rate, 5)
  assert.equal(added.manualTakeProfit.price, 1.061)
  const sold = advance({ ...added, pending: { side: 'sell', quantity: 500, date: sample[2].date } }, sample)
  assert.deepEqual(sold.trades.slice(2).map(({ quantity, price }) => [quantity, price]), [[500, 1.03], [1500, 1.06]])
  assert.equal(sold.cost, 0)
  assert.equal(sold.shares, 0)
  assert.equal(sold.manualTakeProfit, null)
})

test('手动收盘买入立即成交且从下一根判断止盈，次日开盘买入仍需等待', () => {
  const sample = [
    { date: '2025-01-02', open: 0.99, close: 1, high: 1.08, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 1.02, close: 1.025, high: 1.029, low: 1.019, volume: 10000 },
  ]
  const session = startSession(0, defaultSettings)
  const closed = submitManualOrder(session, sample, 'buy', 1000, 1, 'close')
  assert.equal(closed.cursor, 0)
  assert.equal(closed.pending, null)
  assert.equal(closed.manualBuyTiming, 'close')
  assert.equal(closed.trades.length, 1)
  assert.equal(closed.trades[0].fillDate, sample[0].date)
  assert.equal(closed.trades[0].price, 1)
  assert.equal(closed.manualTakeProfit.price, 1.011)
  assert.ok(closed.maxDrawdown > 0)
  assert.equal(advance(closed, sample).trades[1].price, 1.019)

  const queued = submitManualOrder(session, sample, 'buy', 1000, 1, 'open')
  assert.equal(queued.pending.side, 'buy')
  assert.equal(queued.trades.length, 0)
  assert.equal(advance(queued, sample).trades[0].price, 1.02)
})

test('最后一根 K 线可手动按收盘买入，次日开盘委托只能在有下一根时提交', () => {
  const index = resolveDate(bars, '2025-05-26')
  const sample = bars.slice(index - 1, index + 1)
  const session = startSession(1, defaultSettings)
  assert.equal(submitManualOrder(session, sample, 'buy', 1000, 1, 'close').trades[0].price, sample[1].close)
  assert.match(submitManualOrder(session, sample, 'buy', 1000, 1, 'open').message, /末尾/)
  assert.match(submitManualOrder(session, sample, 'sell', 1000, 1, 'close').message, /末尾/)
})

test('逐根回退恢复账户和止盈，下一次推进重新成交，改走其他决策时清除原成交', () => {
  const index = resolveDate(bars, '2025-04-03')
  const initial = startSession(index, defaultSettings)
  const queued = submitManualOrder(initial, bars, 'buy', 1000, 1, 'open')
  const bought = advance(queued, bars)
  const sold = advance(bought, bars)
  assert.equal(sold.shares, 0)
  assert.equal(sold.trades.length, 2)
  assert.deepEqual(rewind(sold), bought)
  assert.deepEqual(advance(rewind(sold), bars), sold)

  const restored = rewind(rewind(sold))
  assert.equal(restored.cash, initial.cash)
  assert.deepEqual(restored.pending, queued.pending)
  assert.equal(restored.trades.length, 0)
  assert.equal(restored.manualTakeProfit, undefined)
  assert.equal(canRewind(restored), false)
  const newPath = advance({ ...restored, pending: null }, bars)
  assert.equal(newPath.trades.length, 0)
  assert.equal(newPath.shares, 0)
})

test('没有旧快照的回放从第一次推进开始回退，当前根上的收盘成交随回退撤销', () => {
  const index = resolveDate(bars, '2025-05-26')
  const legacy = { ...startSession(index - 1, defaultSettings), cursor: index }
  assert.equal(rewind(legacy), legacy)
  const stepped = advance(legacy, bars)
  const bought = submitManualOrder(stepped, bars, 'buy', 1000, 1, 'close')
  assert.equal(bought.trades.length, 1)
  const rolledBack = rewind(bought)
  assert.equal(rolledBack.cursor, legacy.cursor)
  assert.equal(rolledBack.trades.length, 0)
  assert.equal(rolledBack.manualTakeProfit, undefined)
  assert.equal(rolledBack.manualBuyTiming, undefined)
  assert.equal(canRewind(rolledBack), false)
})

test('同日触及两边时止损优先，开盘已经越过一侧则以开盘价为基准取对手价', () => {
  const sample = [
    { date: '2025-01-02', open: 0.99, close: 1, high: 1.08, low: 0.95, volume: 10000 },
    { date: '2025-01-03', open: 1, close: 1, high: 1.02, low: 0.98, volume: 10000 },
  ]
  const initial = startSession(0, defaultSettings)
  const bought = submitManualOrder(initial, sample, 'buy', 1000, 1, 'close')
  assert.equal(bought.trades.length, 1)
  assert.equal(bought.manualStopLoss.rate, 1)
  assert.equal(bought.manualStopLoss.price, 0.991)
  assert.equal(bought.manualTakeProfit.price, 1.011)

  const stopped = advance(bought, sample)
  assert.equal(stopped.trades[1].stopLossRate, 1)
  assert.equal(stopped.trades[1].price, 0.992)
  assert.equal(stopped.trades[1].realized, -8.1)
  assert.equal(stopped.manualStopLoss, null)
  assert.equal(stopped.manualTakeProfit, null)
  assert.deepEqual(rewind(stopped).manualStopLoss, bought.manualStopLoss)

  const gapDown = advance(bought, [sample[0], { ...sample[1], open: 0.985 }])
  assert.equal(gapDown.trades[1].price, 0.986)
  assert.equal(gapDown.trades[1].stopLossRate, 1)
  const gapUp = advance(bought, [sample[0], { ...sample[1], open: 1.02 }])
  assert.equal(gapUp.trades[1].takeProfitRate, 1)
  assert.equal(gapUp.trades[1].price, 1.019)
  assert.equal(gapUp.manualStopLoss, null)

  assert.match(submitManualOrder(initial, sample, 'buy', 1000, 1, 'open', 10.1).message, /止损率/)
  const queued = submitManualOrder(initial, sample, 'buy', 1000, 1, 'open', 2.5)
  const opened = advance(queued, sample)
  assert.equal(opened.trades[1].takeProfitRate, 1)
  assert.equal(opened.manualStopLoss, null)
})

test('跌停未成交的止损等待下一个可成交开盘，九档止盈对比沿用该笔止损', () => {
  const sample = [
    { date: '2025-01-02', open: 0.99, close: 1, high: 1, low: 0.98, volume: 10000 },
    { date: '2025-01-03', open: 0.99, close: 1, high: 1.02, low: 0.97, volume: 10000 },
    { date: '2025-01-06', open: 0.9, close: 0.9, high: 0.9, low: 0.9, volume: 10000 },
    { date: '2025-01-07', open: 0.995, close: 0.99, high: 0.999, low: 0.986, volume: 10000 },
  ]
  const marked = markReversal(startSession(0, defaultSettings), sample[0], {
    quantity: 1000, entry: 'close', target: 'net', stopLossRate: 1,
  }, false)
  const bought = advance(marked, sample)
  const waiting = advance(bought, sample)
  assert.equal(waiting.strategy.stopTriggered, true)
  assert.equal(waiting.trades.length, 1)
  const [{ alternatives: pending }] = takeProfitResults(waiting.trades, waiting.settings, sample, waiting.cursor)
  assert.ok(pending.every((item) => !item.exit))
  const sold = advance(waiting, sample)
  assert.equal(sold.strategy, null)
  assert.equal(sold.trades[1].price, 0.995)
  assert.equal(sold.trades[1].stopLossRate, 1)
  const [{ alternatives: outcomes }] = takeProfitResults(sold.trades, sold.settings, sample, sold.cursor)
  assert.ok(outcomes.every(({ exit }) => exit?.kind === 'stop' && exit.price === sold.trades[1].price))
})
