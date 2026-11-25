import { writeFileSync } from 'node:fs'
import { csv, meanInterval, scenarios, simulate, stats, tradesCsv } from './backtest.mjs'
import { loadMarkets, marketWindow, windows as sections } from './market.mjs'
import { allSignals, models } from './strategies.mjs'

const write = (filename, content) => writeFileSync(new URL(filename, import.meta.url), content)
const modelNames = Object.keys(models)
const datasets = loadMarkets()

const report = { models, scenarios, sections: {}, results: {}, data: {} }
const ledger = []
const equityRows = []
for (const [name, data] of Object.entries(datasets)) {
  const { sha256, blocked, bars } = data
  data.signals = allSignals(bars)
  report.data[name] = { sha256, qualityFlags: [...blocked].sort() }
}

for (const [section, { dataset, from, through }] of Object.entries(sections)) {
  const { bars, signals, blocked } = datasets[dataset]
  const window = { from, through }
  const { dates, ...coverage } = marketWindow(bars, sections[section])
  report.sections[section] = coverage
  const equity = dates.map((date) => ({ section, date }))
  report.results[section] = {}

  for (const model of modelNames) {
    const base = simulate(bars, signals[model], { ...window, spec: scenarios.base })
    for (const [index, { date, net }] of base.daily.entries()) {
      if (date !== equity[index].date) throw new Error('Unexpected equity series date')
      equity[index][model] = net
    }
    const results = { base: stats(base.trades, base), interval: meanInterval(base.daily, modelNames.length) }
    results.carried = stats(base.trades.filter((trade) => trade.entryDay !== trade.exitDay))
    results.direction = Object.fromEntries(['long', 'short'].map((direction) =>
      [direction, stats(base.trades.filter((trade) => trade.direction === direction))]))
    results.year = Object.fromEntries([...new Set(dates.map((date) => date.slice(0, 4)))].map((year) =>
      [year, stats(base.trades.filter((trade) => trade.exitDay.startsWith(year)))]))

    for (const [scenario, spec] of Object.entries(scenarios)) {
      if (scenario === 'base') continue
      const result = simulate(bars, signals[model], { ...window, spec })
      results[scenario] = stats(result.trades, result)
    }
    const quality = simulate(bars, signals[model], { ...window, spec: scenarios.base, blocked })
    results.excludeFlagged = stats(quality.trades, quality)
    for (const trade of base.trades) {
      const qualityFlags = [...new Set([trade.originDay, trade.signalDay, trade.entryDay, trade.exitDay])]
        .filter((day) => blocked.has(day)).join('|')
      ledger.push({ section, model, ...trade, qualityFlags })
    }
    report.results[section][model] = results
  }
  equityRows.push(...equity)
}

write('summary.json', JSON.stringify(report, null, 2) + '\n')
write('trades.csv', tradesCsv(ledger))
write('daily-net.csv', csv(equityRows, ['section', 'date', ...modelNames]))

console.table(modelNames.map((model) => {
  const { research, validation, recent } = report.results
  const { base, interval, stress } = recent[model]
  return {
    model, researchNet: Math.round(research[model].base.net), validationNet: Math.round(validation[model].base.net),
    recentTrades: base.count, recentNet: Math.round(base.net), recentPF: base.profitFactor?.toFixed(3),
    mean95: interval ? `${interval.low.toFixed(1)} to ${interval.high.toFixed(1)}` : '',
    recentStress: Math.round(stress.net),
  }
}))
