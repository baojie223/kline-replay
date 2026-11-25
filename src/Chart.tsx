import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, TickMarkType,
  createChart, createSeriesMarkers,
} from 'lightweight-charts'
import type { AutoscaleInfo, SeriesMarker, SeriesMarkerBar, SeriesMarkerPrice, Time, UTCTimestamp } from 'lightweight-charts'
import { brooksEntries } from './brooks'
import type { BrooksEntry } from './brooks'
import { ictRetest, ictRetestWindow, ictSetups } from './ict'
import type { IctFill, IctSetup } from './ict'
import type { Bar, Execution } from './replay'
import ChartTrading from './ChartTrading'
import type { ChartTradingOptions } from './ChartTrading'
import { ema20 } from './ema'
import { useChartMarkup } from './chartMarkup'
import type { ChartMarkup } from './chartMarkup'
import { intradayTimestamp } from './maTimeframes'

const up = '#2dc7a1'
const down = '#f1717e'
const brooksLabels = {
  h2: { tag: 'H2', name: 'H2 二次入场', color: '#ffd479' },
  wedgeFlag: { tag: '楔旗', name: '楔形牛旗', color: '#81e3cc' },
  wedgeReversal: { tag: '楔底', name: '楔形底反转', color: '#bdb4ff' },
  range: { tag: '区间', name: '区间下沿反转', color: '#88cdff' },
} satisfies Record<BrooksEntry['pattern'], { tag: string; name: string; color: string }>
const ictLabels = {
  long: { name: '多', color: '#84dbff', position: 'belowBar', shape: 'arrowUp' },
  short: { name: '空', color: '#f1a4e0', position: 'aboveBar', shape: 'arrowDown' },
} as const

type IctMark = { setup: IctSetup; fill?: IctFill }
type ChartBar = Bar & { contract?: string; tradeDate?: string }
type ChartFocus = { from?: number }
export type ChartAnnotation = { index: number; revealAt?: number; marketTime?: string } &
  (Omit<SeriesMarkerBar<Time>, 'time'> | Omit<SeriesMarkerPrice<Time>, 'time'>)

const beijingTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function timeLabel(time: Time) {
  return typeof time === 'number' ? beijingTime.format(time * 1000) : ''
}

function ictMarks(bars: Bar[]) {
  const marks = new Map<number, IctMark[]>()
  function add(index: number, mark: IctMark) {
    const sameBar = marks.get(index)
    if (sameBar) sameBar.push(mark)
    else marks.set(index, [mark])
  }
  for (const setup of ictSetups(bars, 0.001)) {
    add(setup.index, { setup })
    for (let index = setup.index + 1; index <= setup.index + ictRetestWindow && index < bars.length; index++) {
      const retest = ictRetest(bars, setup, index)
      if (retest?.kind === 'filled') add(index, { setup, fill: retest })
      if (retest) break
    }
  }
  return marks
}

function createReplayChart(host: HTMLDivElement, intraday: boolean, precision: number) {
  const chart = createChart(host, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#121720' },
      textColor: '#8391a6',
      fontFamily: 'Geist, ui-monospace, Consolas, monospace',
      attributionLogo: true,
      panes: { separatorColor: '#242c39', separatorHoverColor: '#36435a' },
    },
    grid: { vertLines: { color: '#1e2633' }, horzLines: { color: '#1e2633' } },
    localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd', timeFormatter: intraday ? timeLabel : undefined },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#75849b', labelBackgroundColor: '#354259' },
      horzLine: { color: '#75849b', labelBackgroundColor: '#354259' },
    },
    rightPriceScale: { borderColor: '#242c39', minimumWidth: 72 },
    timeScale: {
      borderColor: '#242c39', rightOffset: 7, barSpacing: 10, timeVisible: intraday, secondsVisible: false,
      tickMarkFormatter: intraday ? (time: Time, type: TickMarkType) => {
        const label = timeLabel(time)
        if (!label) return null
        if (type === TickMarkType.Year) return label.slice(0, 4)
        if (type === TickMarkType.Month || type === TickMarkType.DayOfMonth) return label.slice(5, 10)
        return label.slice(11)
      } : undefined,
    },
  })
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: up, downColor: down, borderVisible: false,
    wickUpColor: up, wickDownColor: down,
    priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
  })
  const ema = chart.addSeries(LineSeries, {
    color: '#f2b65e', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
  })
  const volumes = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
  }, 1)
  chart.panes()[0].setStretchFactor(5)
  chart.panes()[1].setStretchFactor(1)
  const markers = createSeriesMarkers(candles, [])
  return { chart, candles, ema, volumes, markers }
}

function candle(bar: Bar, time: Time) {
  return { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
}

function volume(bar: Bar, time: Time) {
  return { time, value: bar.volume, color: bar.close >= bar.open ? '#2dc7a166' : '#f1717e66' }
}

export default function Chart({
  bars, cursor, start, trades, showBrooks, showIct, markDate, targetPrice, stopPrice, limitPrice,
  intraday = false, precision = 3, focus, annotations, describeBar, trading, entryPrice, forming, markup, nextBar,
}: {
  bars: ChartBar[]; cursor: number; start: number; trades?: Execution[]; showBrooks?: boolean; showIct?: boolean
  markDate?: string; targetPrice?: number; stopPrice?: number; limitPrice?: number
  intraday?: boolean; precision?: number; focus?: ChartFocus; annotations?: ChartAnnotation[]
  describeBar?: (index: number) => ReactNode
  trading?: ChartTradingOptions; entryPrice?: number
  forming?: ChartBar; markup?: ChartMarkup; nextBar?: { label: string; disabled: boolean; advance: () => void }
}) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<ReturnType<typeof createReplayChart> | null>(null)
  const previous = useRef<{ cursor: number; start: number; focus?: ChartFocus; forming?: ChartBar }>({ cursor: -1, start: -1 })
  const [hover, setHover] = useState<Time>()
  const [instance, setInstance] = useState<ReturnType<typeof createReplayChart>>()
  const [expanded, setExpanded] = useState(false)
  const [showEma, setShowEma] = useState(false)
  const lastEma = useRef<{ values: ReturnType<typeof ema20>; cursor: number }>(undefined)
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  const times = useMemo(() => bars.map(({ date }): Time =>
    intraday ? intradayTimestamp(date) as UTCTimestamp : date), [bars, intraday])
  const indicesByTime = useMemo(() => new Map(times.map((time, index) => [time, index])), [times])
  const emaValues = useMemo(() => ema20(bars), [bars])
  const brooksByDate = useMemo(() => {
    const byDate = new Map<string, BrooksEntry[]>()
    if (!showBrooks) return byDate
    for (const entry of brooksEntries(bars, cursor)) {
      const sameDay = byDate.get(entry.date)
      if (sameDay) sameDay.push(entry)
      else byDate.set(entry.date, [entry])
    }
    return byDate
  }, [bars, cursor, showBrooks])
  const ictByIndex = useMemo(() => showIct ? ictMarks(bars) : undefined, [bars, showIct])

  useEffect(() => {
    const instance = createReplayChart(host.current!, intraday, precision)
    api.current = instance
    setInstance(instance)
    const onHover = (event: { time?: Time }) => setHover(event.time)
    instance.chart.subscribeCrosshairMove(onHover)
    return () => {
      instance.chart.remove()
      api.current = null
      previous.current = { cursor: -1, start: -1 }
      lastEma.current = undefined
    }
  }, [intraday, precision])

  useEffect(() => {
    const instance = api.current!
    const { chart, candles, volumes } = instance
    const prior = previous.current
    const jumped = prior.focus !== focus
    const previousCursor = prior.cursor
    const advance = cursor - previousCursor
    const sameReplay = !jumped && prior.start === start
    const barAt = (index: number) => index === cursor && forming ? forming : bars[index]
    function update(index: number) {
      const bar = barAt(index)
      candles.update(candle(bar, times[index]))
      volumes.update(volume(bar, times[index]))
    }
    if (sameReplay && advance === 0 && prior.forming !== forming) {
      update(cursor)
    } else if (sameReplay && !prior.forming && advance > 0 && advance <= 5) {
      const followsLatest = (chart.timeScale().getVisibleLogicalRange()?.to ?? cursor) >= previousCursor - 1
      for (let index = previousCursor + 1; index <= cursor; index++) update(index)
      if (followsLatest) chart.timeScale().scrollToRealTime()
    } else if (jumped || previous.current.cursor !== cursor || previous.current.start !== start) {
      const visible = bars.slice(0, cursor + 1)
      if (forming) visible[cursor] = forming
      instance.markers.setMarkers([])
      candles.setData(visible.map((bar, index) => candle(bar, times[index])))
      volumes.setData(visible.map((bar, index) => volume(bar, times[index])))
      const width = host.current?.clientWidth ?? 900
      const windowSize = Math.max(20, Math.min(76, Math.floor((width - 72) / 10)))
      const from = Math.min(cursor - windowSize + 7, ((jumped ? focus?.from : undefined) ?? cursor) - 4)
      chart.timeScale().setVisibleLogicalRange({ from, to: cursor + 7 })
      setHover(undefined)
    }
    previous.current = { cursor, start, focus, forming }
  }, [bars, cursor, start, focus, forming, times, precision])

  useEffect(() => {
    const { ema } = api.current!
    const completed = forming ? cursor - 1 : cursor
    if (!showEma) {
      if (lastEma.current) ema.setData([])
      lastEma.current = undefined
      return
    }
    const point = (value: number | undefined, index: number) =>
      value === undefined ? { time: times[index] } : { time: times[index], value }
    const previous = lastEma.current
    if (previous?.values === emaValues && completed >= previous.cursor && completed - previous.cursor <= 5) {
      for (let index = previous.cursor + 1; index <= completed; index++) {
        ema.update(point(emaValues[index], index))
      }
    } else {
      ema.setData(emaValues.slice(0, completed + 1).map(point))
    }
    lastEma.current = { values: emaValues, cursor: completed }
  }, [showEma, emaValues, cursor, times, intraday, precision, forming])

  useEffect(() => {
    const markers = trades?.map<SeriesMarker<Time>>((trade) => ({
      time: trade.fillDate,
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      color: trade.side === 'buy' ? up : down,
      text: trade.side === 'buy' ? '买' : trade.stopLossRate !== undefined ? '止损' : trade.takeProfitRate === undefined ? '卖' : '止盈',
    })) ?? []
    const reversalDates = new Set(trades?.flatMap((trade) => trade.reversal ? [trade.reversal.markDate] : []))
    if (markDate) reversalDates.add(markDate)
    for (const date of reversalDates) markers.push({
      time: date, position: 'belowBar', shape: 'circle', color: '#afbcff', text: '逆转',
    })
    for (const [date, entries] of brooksByDate) {
      const color = brooksLabels[entries[0].pattern].color
      markers.push({ time: date, position: 'atPriceMiddle', price: entries[0].trigger, shape: 'circle', size: 0.65, color })
      markers.push({
        time: date, position: 'aboveBar', shape: 'circle', size: 0, color,
        text: entries.map(({ pattern }) => brooksLabels[pattern].tag).join(' · '),
      })
    }
    for (const [index, marks] of ictByIndex ?? []) {
      if (index > cursor) continue
      const time = bars[index].date
      for (const { setup, fill } of marks) {
        const { name, color, position, shape } = ictLabels[setup.direction]
        markers.push({
          time, position, color, shape: fill ? shape : 'circle', size: fill ? 1 : 0.55,
          text: fill ? `ICT ${name}` : undefined,
        })
        if (fill) markers.push({
          time, position: 'atPriceMiddle', price: fill.price, shape: 'circle', size: 0.65, color,
        })
      }
    }
    for (const { index, revealAt = index, marketTime: _marketTime, ...marker } of annotations ?? []) {
      if (revealAt <= cursor && index <= cursor) markers.push({ ...marker, time: times[index] })
    }
    markers.sort((first, second) => typeof first.time === 'number' && typeof second.time === 'number'
      ? first.time - second.time : String(first.time).localeCompare(String(second.time)))
    api.current?.markers.setMarkers(markers)
  }, [trades, markDate, bars, cursor, start, focus, forming, brooksByDate, ictByIndex, times, annotations, precision])

  useEffect(() => {
    if (!api.current) return
    const { candles } = api.current
    const target = targetPrice === undefined || trading ? undefined : candles.createPriceLine({
      price: targetPrice, title: '止盈', color: '#acbcff', lineStyle: LineStyle.Dashed,
    })
    const stop = stopPrice === undefined || trading ? undefined : candles.createPriceLine({
      price: stopPrice, title: '止损', color: down, lineStyle: LineStyle.Dashed,
    })
    const limit = limitPrice === undefined || trading?.pending ? undefined : candles.createPriceLine({
      price: limitPrice, title: '挂单', color: '#e5b962', lineStyle: LineStyle.Dashed,
    })
    const entry = entryPrice === undefined || trading?.filled ? undefined : candles.createPriceLine({
      price: entryPrice, title: '持仓均价', color: '#84dbff', lineStyle: LineStyle.Dotted,
    })
    candles.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const info = original()
      if (!info?.priceRange) return info
      const prices = [targetPrice, stopPrice, entryPrice, limitPrice].filter((value): value is number => value !== undefined)
      return { ...info, priceRange: {
        minValue: Math.min(info.priceRange.minValue, ...prices),
        maxValue: Math.max(info.priceRange.maxValue, ...prices),
      } }
    } })
    return () => {
      if (!api.current) return
      if (target) candles.removePriceLine(target)
      if (stop) candles.removePriceLine(stop)
      if (limit) candles.removePriceLine(limit)
      if (entry) candles.removePriceLine(entry)
    }
  }, [targetPrice, stopPrice, limitPrice, entryPrice, !!trading, !!trading?.pending, !!trading?.filled, intraday, precision])

  const highlight = useChartMarkup(instance, api, times as readonly number[], cursor, intraday ? markup : undefined)
  const index = hover === undefined ? undefined : indicesByTime.get(hover)
  const shownIndex = index !== undefined && index <= cursor ? index : highlight?.to ?? cursor
  const shownForming = shownIndex === cursor ? forming : undefined
  const bar = shownForming ?? bars[shownIndex]
  const setups = brooksByDate.get(bar.date)
  const ict = ictByIndex?.get(shownIndex)
  const priorBar = bars[shownIndex - 1]
  const lastClose = priorBar?.contract === bar.contract ? priorBar?.close ?? bar.open : bar.open
  const change = (bar.close / lastClose - 1) * 100

  return (
    <div className={`chart-body${expanded ? ' chart-expanded' : ''}`} data-drawing={markup?.tool}>
      {trading && instance && <ChartTrading key={trading.placement?.label ?? (trading.pending ? 'pending' : trading.filled ? 'filled' : 'draft')}
        chart={instance.chart} candles={instance.candles} host={host}
        prices={{ target: targetPrice, stop: stopPrice }} precision={precision} options={trading} />}
      <div className="chart-readout" aria-label="K 线行情">
        <div className="ohlc">
          <span className="chart-date">{bar.date}</span>
          {shownForming && <span className="chart-forming">形成中</span>}
          {bar.contract && <b>{bar.contract}</b>}
          {([['开', bar.open], ['高', bar.high], ['低', bar.low], ['收', bar.close]] as const)
            .map(([label, value]) => <span key={label}>{label} <b>{value.toFixed(precision)}</b></span>)}
          <b className={change >= 0 ? 'positive' : 'negative'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</b>
          {showEma && !shownForming && emaValues[shownIndex] !== undefined &&
            <span className="ema-value">EMA20 {emaValues[shownIndex].toFixed(precision)}</span>}
        </div>
        <div className="volume-readout">
          成交量 <b>{(bar.volume / 10000).toFixed(2)} 万手</b>
          {intraday && <span> · 交易日 {bar.tradeDate}</span>}
        </div>
        {setups?.map(({ pattern, trigger, signalDate, detail, evidence }) => (
          <div key={pattern} className="brooks-readout" style={{ color: brooksLabels[pattern].color }}>
            <div>{brooksLabels[pattern].name} · 触发价 ¥{trigger.toFixed(3)} · 信号 K 线 {signalDate}</div>
            <div>{detail}</div>
            {evidence.length > 0 && <div>摆动点 {evidence.map(({ date, price }) => `${date.slice(5)} ¥${price.toFixed(3)}`).join(' / ')}</div>}
          </div>
        ))}
        {describeBar?.(shownIndex)}
        {ict?.map(({ setup, fill }) => (
          <div key={`${setup.direction}-${setup.index}`} className="signal-readout"
            style={{ color: ictLabels[setup.direction].color }}>
            <div>
              ICT {ictLabels[setup.direction].name} ·
              {fill ? ` 回踩入场 ¥${fill.price.toFixed(3)} · 确认日 ${bars[setup.index].date}`
                : ` 等待回踩 ¥${setup.entry.toFixed(3)}`}
            </div>
            <div>
              扫过 ¥{setup.sweep.liquidity.price.toFixed(3)}（{bars[setup.sweep.index].date}） ·
              收破 ¥{setup.sweep.structure.price.toFixed(3)}（{bars[setup.shiftIndex].date}）
            </div>
            <div>
              FVG ¥{setup.gapLow.toFixed(3)}–{setup.gapHigh.toFixed(3)} ·
              止损 ¥{setup.stop.toFixed(3)} · 目标 ¥{setup.target.toFixed(3)}
            </div>
          </div>
        ))}
      </div>
      <div className="chart-canvas" ref={host} />
      <div className="chart-controls">
        {expanded && nextBar && <button type="button" className="button small" aria-label={`放大图 ${nextBar.label}`}
          disabled={nextBar.disabled} onClick={nextBar.advance}>下一根</button>}
        <button className="button small" aria-label={expanded ? '退出图表放大' : '放大图表'}
          onClick={() => setExpanded((value) => !value)}>{expanded ? '退出放大 · Esc' : '放大图表'}</button>
        <button type="button" className="button small ema-toggle" aria-pressed={showEma}
          onClick={() => setShowEma((visible) => !visible)}>EMA20</button>
        <button className="chart-follow button small" onClick={() => {
          markup?.selectCandle()
          api.current?.chart.timeScale().scrollToRealTime()
        }}>回到当前</button>
      </div>
    </div>
  )
}
