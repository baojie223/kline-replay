import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ictSetups } from '../src/ict.ts'
import { maBaseCosts, maWindow, parseMaMarket, simulate, withMaRolls } from '../src/maBacktest.ts'
export { simulate } from '../src/maBacktest.ts'

const { from, through } = maWindow
const folder = new URL('../research/ma-ict/', import.meta.url)

const scenarios = {
  noCosts: { feeRate: 0, marketExitTicks: 0 },
  base: maBaseCosts,
  higherCosts: { feeRate: 0.0004, marketExitTicks: 2 },
}

function readMarket(period) {
  const name = 'market-' + period + '.csv'
  const text = readFileSync(new URL(name, folder), 'utf8')
  return { name, bars: parseMaMarket(text, period), sha256: createHash('sha256').update(text).digest('hex') }
}

function minutesBetween(start, end) {
  const times = []
  for (let minute = start + 5; minute <= end; minute += 5) {
    const hour = String(Math.floor(minute / 60)).padStart(2, '0')
    const part = String(minute % 60).padStart(2, '0')
    times.push(hour + ':' + part)
  }
  return times
}

function auditMarket(daily, intraday) {
  const noNight = new Set(['2026-01-05', '2026-02-24', '2026-04-07', '2026-05-06', '2026-06-22', '2026-09-28', '2026-10-08'])
  const day = [...minutesBetween(540, 615), ...minutesBetween(630, 690), ...minutesBetween(810, 900)]
  const full = [...minutesBetween(1260, 1380), ...day]
  const byDate = new Map()
  for (const bar of intraday) {
    const group = byDate.get(bar.tradeDate)
    if (group) group.push(bar)
    else byDate.set(bar.tradeDate, [bar])
  }
  if (daily.length !== byDate.size || daily.at(-1)?.tradeDate !== through) {
    throw new Error('Daily and 5-minute snapshots cover different trading dates')
  }
  const inWindow = daily.filter(({ tradeDate }) => tradeDate >= from)
  if (inWindow.length !== 242 || inWindow[0]?.tradeDate !== from) throw new Error('Incomplete one-year trading calendar')

  let exactOhlc = 0
  let minuteCount = 0
  let maxRangeDifference = 0
  let maxVolumeDifferencePercent = 0
  const materialDifferences = []
  for (const bar of daily) {
    const group = byDate.get(bar.tradeDate)
    const expected = noNight.has(bar.tradeDate) ? day : full
    if (!group || group.length !== expected.length ||
        group.some((item, index) => item.contract !== bar.contract || item.date.slice(11) !== expected[index]) ||
        group[0].open !== bar.open || group.at(-1).close !== bar.close) {
      throw new Error('5-minute session or daily O/C mismatch on ' + bar.tradeDate)
    }
    const highDifference = bar.high - Math.max(...group.map((item) => item.high))
    const lowDifference = Math.min(...group.map((item) => item.low)) - bar.low
    const volumeDifferencePercent = 100 * (bar.volume - group.reduce((sum, item) => sum + item.volume, 0)) / bar.volume
    if (highDifference < 0 || lowDifference < 0) throw new Error('5-minute prices outside daily range on ' + bar.tradeDate)
    if (bar.tradeDate < from) continue
    minuteCount += group.length
    if (!highDifference && !lowDifference) exactOhlc++
    maxRangeDifference = Math.max(maxRangeDifference, highDifference, lowDifference)
    maxVolumeDifferencePercent = Math.max(maxVolumeDifferencePercent, Math.abs(volumeDifferencePercent))
    if (Math.max(highDifference, lowDifference) > 5 || Math.abs(volumeDifferencePercent) > 1) {
      materialDifferences.push({
        tradeDate: bar.tradeDate, contract: bar.contract, highDifference, lowDifference,
        volumeDifferencePercent: +volumeDifferencePercent.toFixed(4),
      })
    }
  }
  return {
    tradingDays: inWindow.length, fiveMinuteBars: minuteCount, exactOpenClose: inWindow.length, exactOhlc,
    maxRangeDifference, maxVolumeDifferencePercent, materialDifferences,
  }
}

function tradeStats(trades) {
  const winners = trades.filter((trade) => trade.net > 0)
  const losses = trades.filter((trade) => trade.net < 0)
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0)
  const gains = sum(winners, 'net')
  const lost = -sum(losses, 'net')
  return {
    count: trades.length, wins: winners.length, losses: losses.length, winRate: trades.length ? winners.length / trades.length : null,
    gross: sum(trades, 'gross'), fees: sum(trades, 'fee'), slippage: sum(trades, 'slippage'), net: sum(trades, 'net'),
    meanR: trades.length ? sum(trades, 'netR') / trades.length : null, profitFactor: lost ? gains / lost : null,
    largestWin: winners.length ? Math.max(...winners.map((trade) => trade.net)) : null,
    largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.net)) : null,
  }
}

function summarize(result) {
  const { trades, ...state } = result
  return {
    ...state, ...tradeStats(trades),
    long: tradeStats(trades.filter((trade) => trade.direction === 'long')),
    short: tradeStats(trades.filter((trade) => trade.direction === 'short')),
    firstHalf: tradeStats(trades.filter((trade) => trade.entryDay < '2026-05-17')),
    secondHalf: tradeStats(trades.filter((trade) => trade.entryDay >= '2026-05-17')),
    exits: trades.reduce((counts, trade) => ({ ...counts, [trade.reason]: (counts[trade.reason] ?? 0) + 1 }), {}),
  }
}

function run() {
  const daily = readMarket('1d')
  const minute = readMarket('5m')
  const audit = auditMarket(daily.bars, minute.bars)
  const rolls = daily.bars.filter((bar) => bar.rollFrom).map(({ tradeDate, contract, rollFrom, rollExitOpen }) =>
    ({ tradeDate, contract, rollFrom, rollExitOpen }))
  const intraday = withMaRolls(minute.bars, daily.bars)
  const qualityDates = new Set(audit.materialDifferences.map((day) => day.tradeDate))
  const results = {}
  const trades = []
  for (const [period, bars] of [['5m', intraday], ['1d', daily.bars]]) {
    const setups = ictSetups(bars, 1)
    results[period] = {}
    for (const [name, costs] of Object.entries(scenarios)) {
      const result = simulate(bars, { intraday: period === '5m', ...costs }, setups)
      results[period][name] = summarize(result)
      if (name !== 'base') continue
      for (const trade of result.trades) {
        const evidence = [trade.sweepDay, trade.shiftDay, trade.signalDay, trade.entryDay, trade.exitDay]
        const qualityFlags = period === '5m' ? [...new Set(evidence)].filter((day) => qualityDates.has(day)).join('|') : ''
        trades.push({ period, ...trade, qualityFlags })
      }
    }
  }
  const flaggedTrades = trades.filter((trade) => trade.qualityFlags)
  const summary = {
    from, through, audit, rolls, scenarios, results,
    minuteTradesOnFlaggedDates: tradeStats(flaggedTrades),
    inputs: [daily, minute].map(({ name, bars, sha256 }) => ({ name, count: bars.length, sha256 })),
  }
  writeFileSync(new URL('summary.json', folder), JSON.stringify(summary, null, 2) + '\n')
  const columns = [
    'period', 'contract', 'direction', 'sweep', 'sweepDay', 'sweptPrice', 'shift', 'shiftDay', 'shiftPrice',
    'signal', 'signalDay', 'gapLow', 'gapHigh', 'limit', 'entry', 'entryDay', 'entryPrice', 'entryAtOpen', 'stop',
    'target', 'exit', 'exitDay', 'exitPrice', 'reason', 'gross', 'fee', 'slippage', 'net', 'netR', 'qualityFlags',
  ]
  const lines = trades.map((trade) => columns.map((column) => {
    const value = trade[column]
    return Number.isInteger(value) || typeof value !== 'number' ? value : value.toFixed(4)
  }).join(','))
  writeFileSync(new URL('trades.csv', folder), [columns.join(','), ...lines].join('\n') + '\n')
  console.table(Object.entries(results).map(([period, { base }]) => ({
    period, signals: base.signalCount, trades: base.count, winRate: base.winRate?.toFixed(4),
    netCny: base.net.toFixed(2), maxDrawdownCny: base.maxDrawdown.toFixed(2), profitFactor: base.profitFactor?.toFixed(3),
  })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()

