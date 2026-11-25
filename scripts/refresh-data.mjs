import { writeFile, rename } from 'node:fs/promises'

const hongKongDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong' }).format()
const previousDate = new Date(hongKongDate + 'T00:00:00Z')
previousDate.setUTCDate(previousDate.getUTCDate() - 1)
const end = (process.argv[2] ?? previousDate.toISOString().slice(0, 10)).replaceAll('-', '')
if (!/^\d{8}$/.test(end)) throw new Error('Use YYYY-MM-DD for the end date')

const endpoint = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get')
endpoint.search = new URLSearchParams({
  secid: '0.159941',
  fields1: 'f1,f2,f3,f4,f5,f6',
  fields2: 'f51,f52,f53,f54,f55,f56',
  klt: '101',
  fqt: '0',
  beg: '20230101',
  end,
  lmt: '10000',
})
const response = await fetch(endpoint, { signal: AbortSignal.timeout(20_000) })
if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`)
const { data } = await response.json()
if (data?.code !== '159941' || !Array.isArray(data.klines) || data.klines.length < 100) {
  throw new Error('Unexpected Eastmoney response')
}
const bars = data.klines.map((line, index) => {
  const [date, ...fields] = line.split(',')
  const [open, close, high, low, volume] = fields.map(Number)
  const previousDate = data.klines[index - 1]?.split(',')[0]
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || (previousDate && date <= previousDate) ||
    fields.length !== 5 || fields.some((field) => !field.trim()) ||
    ![open, close, high, low, volume].every(Number.isFinite) ||
    low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || volume < 0
  ) throw new Error(`Invalid OHLCV on ${date}`)
  return { date, open, high, low, close, volume }
})
const path = new URL('../public/data/159941.json', import.meta.url)
const temporary = new URL('../public/data/159941.json.tmp', import.meta.url)
await writeFile(temporary, JSON.stringify({ symbol: '159941', source: '东方财富', bars }) + '\n')
await rename(temporary, path)
console.log(`159941: ${bars.length} bars, ${bars[0].date} to ${bars.at(-1).date}`)
