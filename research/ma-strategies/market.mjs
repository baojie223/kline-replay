import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { maWindow, parseMaMarket } from '../../src/maBacktest.ts'

const read = (filename) => readFileSync(new URL(filename, import.meta.url))
const historyAudit = JSON.parse(read('history-audit.json'))
const recentAudit = JSON.parse(read('../ma-ict/summary.json'))

export const windows = {
  research: { dataset: 'history', from: historyAudit.from, through: '2022-12-31' },
  validation: { dataset: 'history', from: '2023-01-01', through: historyAudit.through },
  recent: { dataset: 'recent', ...maWindow },
}

function dataset(input, expectedHash, blocked) {
  const sha256 = createHash('sha256').update(input).digest('hex')
  if (sha256 !== expectedHash) throw new Error('Market snapshot does not match its audit hash')
  return { bars: parseMaMarket(input.toString('utf8'), '5m'), blocked, sha256 }
}

export function loadMarkets() {
  const historicalFlags = new Set(historyAudit.unexpectedSchedules.map(({ day }) => day))
  for (const audit of historyAudit.official) {
    if (audit.error) continue
    const { day, difference, exchangeVolume, exchangeLead, minuteLead } = audit
    if (difference.open || difference.close || Math.abs(difference.high) > 5 || Math.abs(difference.low) > 5 ||
        Math.abs(difference.volume / exchangeVolume) > 0.01 || exchangeLead !== minuteLead) {
      historicalFlags.add(day)
    }
  }
  return {
    history: dataset(gunzipSync(read('history-5m.csv.gz')), historyAudit.marketSha256, historicalFlags),
    recent: dataset(read('../ma-ict/market-5m.csv'), recentAudit.inputs.find(({ name }) => name === 'market-5m.csv').sha256,
      new Set(recentAudit.audit.materialDifferences.map(({ tradeDate }) => tradeDate))),
  }
}

export function marketWindow(bars, { dataset, from, through }) {
  const sample = bars.filter(({ tradeDate }) => tradeDate >= from && tradeDate <= through)
  if (!sample.length || !sample.at(-1).date.endsWith(' 15:00')) throw new Error('Invalid study window starting ' + from)
  const dates = [...new Set(sample.map(({ tradeDate }) => tradeDate))]
  return { dataset, from: dates[0], through: dates.at(-1), bars: sample.length, days: dates.length, dates }
}
