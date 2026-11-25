import { writeFileSync } from 'node:fs'
import { csv, meanInterval, scenarios, simulate, stats, tradesCsv } from '../ma-strategies/backtest.mjs'
import { loadMarkets, marketWindow, windows } from '../ma-strategies/market.mjs'
import { emaModels, emaOrders, filters } from './strategies.mjs'

const models = { ...emaModels, ...Object.fromEntries(Object.entries(filters).map(([key, { label }]) => [key, label])) }
const ids = Object.keys(models)
const fixedTargets = new Set(['gap20_extreme', 'reversion', 'cross_exit'])
const report = { models, filters, data: {}, sections: {}, scenarios, results: {} }
const ledger = []
const daily = []
const markets = loadMarkets()
for (const [key, dataset] of Object.entries(markets)) {
  dataset.orders = emaOrders(dataset.bars)
  report.data[key] = { sha256: dataset.sha256, qualityFlags: [...dataset.blocked].sort() }
}

for (const [section, window] of Object.entries(windows)) {
  const { bars, blocked, orders: { output, comparators, exitOnRecross } } = markets[window.dataset]
  const { dates, ...coverage } = marketWindow(bars, window)
  report.sections[section] = coverage
  report.results[section] = {}
  const pnl = dates.map((date) => ({ section, date }))

  for (const model of ids) {
    const options = { ...window, exitAtNextOpen: model === 'cross_exit' ? exitOnRecross : undefined }
    const base = simulate(bars, output[model], { ...options, spec: scenarios.base })
    const result = { base: stats(base.trades, base), interval: meanInterval(base.daily, ids.length) }
    for (const [index, day] of base.daily.entries()) {
      if (day.date !== dates[index]) throw new Error('Mismatched daily P&L date: ' + day.date)
      pnl[index][model] = day.net
    }
    result.byDirection = Object.fromEntries(['long', 'short'].map((direction) =>
      [direction, stats(base.trades.filter((trade) => trade.direction === direction))]))
    result.byYear = Object.fromEntries([...new Set(dates.map((date) => date.slice(0, 4)))].map((year) =>
      [year, stats(base.trades.filter((trade) => trade.exitDay.startsWith(year)))]))
    if (comparators[model]) {
      const control = simulate(bars, comparators[model], { ...options, spec: scenarios.base })
      result.withoutEma = stats(control.trades, control)
    }

    for (const [name, spec] of Object.entries(scenarios)) {
      if (name === 'base' || (fixedTargets.has(model) && (name === 'oneR' || name === 'threeR'))) continue
      const test = simulate(bars, output[model], { ...options, spec })
      result[name] = stats(test.trades, test)
    }
    const quality = simulate(bars, output[model], { ...options, spec: scenarios.base, blocked })
    result.excludeFlagged = stats(quality.trades, quality)
    result.carried = stats(base.trades.filter(({ entryDay, exitDay }) => entryDay !== exitDay))
    for (const trade of base.trades) {
      const qualityFlags = [...new Set([trade.originDay, trade.signalDay, trade.entryDay, trade.exitDay])]
        .filter((date) => blocked.has(date)).join('|')
      ledger.push({ section, model, ...trade, qualityFlags })
    }
    report.results[section][model] = result
  }
  daily.push(...pnl)
}

const write = (name, content) => writeFileSync(new URL(name, import.meta.url), content)
write('summary.json', JSON.stringify(report, null, 2) + '\n')
write('trades.csv', tradesCsv(ledger))
write('daily-net.csv', csv(daily, ['section', 'date', ...ids]))

const { research, validation, recent } = report.results
console.table(ids.map((model) => ({
  model, research: Math.round(research[model].base.net), validation: Math.round(validation[model].base.net),
  recent: Math.round(recent[model].base.net), trades: recent[model].base.count,
  mean: recent[model].base.mean?.toFixed(2), pf: recent[model].base.profitFactor?.toFixed(3),
  gross: recent[model].base.gross, stress: Math.round(recent[model].stress.net),
})))
