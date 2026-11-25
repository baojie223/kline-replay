import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { MousePointer2, SkipForward, Slash, Square, Trash2 } from 'lucide-react'
import Chart from './Chart'
import type { DrawingPoint, DrawingTool } from './chartMarkup'
import type { ChartTradingOptions } from './ChartTrading'
import type { MaBar } from './maBacktest'
import { intradayTimestamp, maChartCursor, maFifteenMinuteBars, maFifteenMinuteFrame, maFormingFive, maNextChartPoint, maReplayDate } from './maTimeframes'
import type { CandleInterval, MaChartPeriod, MaReplayPoint } from './maTimeframes'
import type { ProtectionKind } from './protection'
import { useReplayDrawings } from './useReplayDrawings'

type ChartProps = Omit<ComponentProps<typeof Chart>, 'bars' | 'forming' | 'markup' | 'nextBar'> & { bars: MaBar[] }
type MaTrading = Omit<ChartTradingOptions, 'onChange' | 'pending' | 'placement'> & {
  onChange: (kind: ProtectionKind, price: number, period?: MaChartPeriod) => string | void
  pending?: Omit<NonNullable<ChartTradingOptions['pending']>, 'onChange'> & { onChange: (price: number, period?: MaChartPeriod) => string | void }
  placement?: Omit<NonNullable<ChartTradingOptions['placement']>, 'onPlace'> & { onPlace: (price: number, period?: MaChartPeriod) => string | void }
}
type Props = Omit<ChartProps, 'trading'> & {
  trading?: MaTrading; drawingScope: string; pausePlayback: () => void; onAdvance: (point: MaReplayPoint) => void
  minute?: number; minutes?: MaBar[]; onActivePeriod?: (period: MaChartPeriod) => void
}
const periods: readonly MaChartPeriod[] = [1, 5, 15]
const periodKey = 'etf-replay/ma/chart-periods'
const selectionTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function readPeriods(): MaChartPeriod[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(periodKey) ?? 'null')
    const valid = Array.isArray(saved) ? periods.filter((period) => saved.includes(period)) : []
    if (valid.length) return valid
  } catch {
    // The default view is available even when browser storage is disabled.
  }
  return [5]
}

function containingBar(bars: MaBar[], date: string) {
  const index = maChartCursor(bars, date)
  return bars[index]?.date === date ? index : index + 1
}

function IntradayCharts({ drawingScope, pausePlayback, onAdvance, minute, minutes, onActivePeriod, ...props }: Props) {
  const { bars, cursor, trading, focus } = props
  const [enabled, setEnabled] = useState(readPeriods)
  const [active, setActive] = useState<MaChartPeriod>(5)
  const [selection, setSelection] = useState<CandleInterval>()
  const [tool, setTool] = useState<DrawingTool>()
  const [color, setColor] = useState('#78baff')
  const [draft, setDraft] = useState<{ period: MaChartPeriod; point: DrawingPoint }>()
  const [selectedId, setSelectedId] = useState<string>()
  const [context, setContext] = useState<{ id: string; x: number; y: number }>()
  const menu = useRef<HTMLDivElement>(null)
  const { drawings, save, remove, storageError } = useReplayDrawings(drawingScope)
  const placing = !!trading?.placement
  const fifteen = useMemo(() => maFifteenMinuteBars(bars), [bars])
  const current = bars[cursor + (minute ? 1 : 0)]
  const currentDate = maReplayDate(bars, { cursor, minute })
  const through = intradayTimestamp(currentDate)
  const visibleDrawings = useMemo(() => drawings.filter((drawing) => drawing.revealedAt <= through), [drawings, through])
  const selectedDrawing = visibleDrawings.find((drawing) => drawing.id === selectedId)
  const contextDrawing = context && visibleDrawings.find((drawing) => drawing.id === context.id)
  const range = useMemo(() => selection && selection.from < through
    ? { from: selection.from, to: Math.min(selection.to, through) } : undefined, [selection, through])
  const minuteCursor = minutes ? maChartCursor(minutes, currentDate) : -1
  const minuteBar = minutes?.[minuteCursor]
  const minuteReady = minuteBar?.date === currentDate && minuteBar.contract === current.contract
  const formingFive = useMemo(() => minute && minuteReady && minutes ? maFormingFive(minutes, current, minute, minuteCursor) : undefined,
    [current, minute, minuteCursor, minuteReady, minutes])
  const fifteenFrame = useMemo(() => maFifteenMinuteFrame(bars, cursor, fifteen, formingFive), [bars, cursor, fifteen, formingFive])
  const activePeriod = enabled.includes(active) && (active !== 1 || minuteReady) ? active
    : enabled.find((period) => period === 5 || (period === 15 && fifteenFrame.cursor >= 0) || (period === 1 && minuteReady))
  const viewFocus = useMemo(() => {
    if (!focus) return {}
    const date = focus.from === undefined ? undefined : bars[focus.from]?.date
    return {
      1: { from: date && minutes ? containingBar(minutes, date) : undefined },
      5: focus,
      15: { from: date ? containingBar(fifteen, date) : undefined },
    }
  }, [bars, fifteen, focus, minutes])

  useEffect(() => {
    if (activePeriod !== undefined) onActivePeriod?.(activePeriod)
  }, [activePeriod, onActivePeriod])

  useEffect(() => {
    if (!placing) return
    setDraft(undefined)
  }, [placing])

  useEffect(() => {
    if (!context) return
    menu.current?.querySelector('button')?.focus({ preventScroll: true })
    function dismiss() { setContext(undefined) }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) dismiss()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [context])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || (event.target instanceof Element &&
          event.target.closest('input, select, textarea, [contenteditable], [role=dialog]'))) return
      if (event.key === 'Escape') {
        if (draft) { setDraft(undefined); return }
        setTool(undefined)
        setContext(undefined)
        setSelection(undefined)
        setSelectedId(undefined)
      } else if (event.key === 'Delete' && selectedDrawing) {
        event.preventDefault()
        remove(selectedDrawing.id)
        setSelectedId(undefined)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [draft, remove, selectedDrawing])

  function togglePeriod(period: MaChartPeriod) {
    const next = enabled.includes(period) ? enabled.filter((value) => value !== period)
      : periods.filter((value) => value === period || enabled.includes(value))
    if (!next.length) return
    setEnabled(next)
    if (draft?.period === period) setDraft(undefined)
    try { window.localStorage.setItem(periodKey, JSON.stringify(next)) } catch { /* Keep the current view. */ }
  }

  function chooseTool(next?: DrawingTool) {
    trading?.placement?.onCancel()
    if (next) pausePlayback()
    setDraft(undefined)
    setTool(next)
    if (next) setSelectedId(undefined)
  }

  function drawPoint(period: MaChartPeriod, point: DrawingPoint) {
    if (!tool || placing) return
    if (draft?.period === period && draft.point.time <= through) {
      finishDrawing(period, draft.point, point)
      return
    }
    pausePlayback()
    setActive(period)
    setDraft({ period, point })
  }

  function finishDrawing(period: MaChartPeriod, first: DrawingPoint, last: DrawingPoint) {
    if (!tool || placing) return
    if (tool === 'box' ? first.time === last.time || first.price === last.price
      : first.time === last.time && first.price === last.price) return
    pausePlayback()
    const id = crypto.randomUUID()
    save({ id, tool, color, first, last, revealedAt: through })
    setActive(period)
    setDraft(undefined)
  }

  function deleteDrawing(id: string) {
    remove(id)
    setSelectedId((selected) => selected === id ? undefined : selected)
    setContext(undefined)
  }

  function annotationReadout(period: MaChartPeriod, chartBar: MaBar) {
    if (!props.describeBar) return
    const close = intradayTimestamp(chartBar.date)
    const index = Math.min(maChartCursor(bars, chartBar.date), cursor)
    const first = Math.max(0, index - (period === 15 ? 2 : 0))
    return bars.slice(first, index + 1).map((bar, offset) => intradayTimestamp(bar.date) > close - period * 60
      ? <Fragment key={bar.date}>{props.describeBar?.(first + offset)}</Fragment> : null)
  }

  return <>
    <div className="ma-timeframe-toolbar">
      <div className="ma-chart-periods" role="group" aria-label="图表周期">
        {periods.map((period) => <button key={period} type="button" className="button small" aria-pressed={enabled.includes(period)}
          aria-disabled={enabled.length === 1 && enabled[0] === period} onClick={() => togglePeriod(period)}>{period}m</button>)}
      </div>
      <div className="ma-drawing-tools" role="group" aria-label="图表画图工具">
        <button type="button" className="button small" aria-label="游标" title="游标" aria-pressed={!tool}
          onClick={() => chooseTool()}><MousePointer2 size={15} /></button>
        <button type="button" className="button small" aria-pressed={tool === 'line'}
          onClick={() => chooseTool(tool === 'line' ? undefined : 'line')}><Slash size={15} />画线</button>
        <button type="button" className="button small" aria-pressed={tool === 'box'}
          onClick={() => chooseTool(tool === 'box' ? undefined : 'box')}><Square size={15} />方框</button>
        <input type="color" className="ma-drawing-color" aria-label="画图颜色" title="画图颜色"
          value={selectedDrawing?.color ?? color} onChange={(event) => {
            const value = event.target.value
            setColor(value)
            if (selectedDrawing) save({ ...selectedDrawing, color: value })
          }} />
        <button type="button" className="button small" aria-label="删除所选画图" title="删除所选画图" disabled={!selectedDrawing}
          onClick={() => { if (selectedDrawing) deleteDrawing(selectedDrawing.id) }}><Trash2 size={15} /></button>
      </div>
      <div className="ma-chart-hint">
        <span role="status">{storageError ? '画图暂未保存到浏览器' : placing ? '在下单图上选择价格' : tool
          ? draft && draft.point.time <= through ? '在同一张图上点终点 · Esc 取消' : '拖动或点两个端点'
          : selectedDrawing ? '已选画图 · 可以改色或删除' : range
            ? `已选区间 ${selectionTime.format(range.from * 1000)}–${selectionTime.format(range.to * 1000).slice(-5)}`
            : '点 K 线联动其他周期'}</span>
        {selection && <button type="button" className="text-button" onClick={() => setSelection(undefined)}>取消高亮</button>}
      </div>
    </div>
    <div className="ma-chart-grid" data-count={enabled.length}>
      {enabled.map((period) => {
        const chartBars = period === 1 ? minutes : period === 5 ? bars : fifteen
        const chartCursor = period === 1 ? minuteCursor : period === 5 ? cursor + (formingFive ? 1 : 0) : fifteenFrame.cursor
        const ready = chartBars && chartCursor >= 0 && (period !== 1 || minuteReady)
        const point = maNextChartPoint(bars, fifteen, { cursor, minute }, period)
        const nextBar = {
          label: `${period} 分钟下一根`, disabled: !point || !ready,
          advance: () => { if (point) { setActive(period); onAdvance(point) } },
        }
        const { pending, placement } = trading ?? {}
        const chartAnnotations = chartBars && props.annotations?.flatMap((marker) => {
          const date = marker.marketTime ?? bars[marker.index].date
          if (date > currentDate || (marker.revealAt !== undefined && marker.revealAt > cursor)) return []
          const index = period === 5 ? marker.index : containingBar(chartBars, date)
          return index <= chartCursor ? [{ ...marker, index, revealAt: index }] : []
        })
        const plotTrading: ChartTradingOptions | undefined = period === activePeriod && trading ? {
          ...trading,
          onChange: (kind, price) => trading.onChange(kind, price, period),
          pending: pending && { ...pending, onChange: (price) => pending.onChange(price, period) },
          placement: placement && { ...placement, onPlace: (price) => placement.onPlace(price, period) },
        } : undefined
        return <section key={period} className="ma-chart-pane" aria-label={`甲醇 ${period} 分钟 K 线`} data-active={activePeriod === period}>
          <div className="ma-chart-pane-heading">
            <h2>{period} 分钟 {period === activePeriod && onActivePeriod && <span>下单图</span>}</h2>
            <button type="button" className="button small" aria-label={nextBar.label} disabled={nextBar.disabled}
              onClick={nextBar.advance}><SkipForward size={13} />下一根</button>
          </div>
          {ready ? <Chart {...props} bars={chartBars} cursor={chartCursor} start={period === 5 ? props.start : 0}
            annotations={chartAnnotations} focus={viewFocus[period]} trading={plotTrading} nextBar={nextBar}
            describeBar={period === 5 ? (index) => index <= cursor && props.describeBar?.(index)
              : (index) => annotationReadout(period, chartBars[index])}
            forming={period === 15 ? fifteenFrame.forming : period === 5 ? formingFive : undefined}
            markup={{
              duration: period * 60, through, selection: range, drawings: visibleDrawings, selectedId,
              tool: placing ? undefined : tool, color, draft: draft?.period === period && draft.point.time <= through ? draft.point : undefined,
              selectCandle: (interval) => {
                if (interval) { pausePlayback(); setActive(period) }
                setSelection((prior) => interval && prior?.from === interval.from && prior.to === interval.to ? undefined : interval)
                setSelectedId(undefined)
              },
              selectDrawing: (id) => { pausePlayback(); setActive(period); setSelectedId(id); setSelection(undefined) },
              openDrawingMenu: (id, x, y) => { pausePlayback(); setContext({ id, x, y }) },
              drawPoint: (point) => drawPoint(period, point),
              drawDrag: (first, last) => finishDrawing(period, first, last),
            }} /> : <p className="ma-timeframe-status" role="status">当前时点没有行情。</p>}
        </section>
      })}
    </div>
    {context && contextDrawing && createPortal(
      <div className="ma-drawing-context" ref={menu} role="menu" aria-label="画图操作"
        style={{ left: Math.min(context.x, window.innerWidth - 128), top: Math.min(context.y, window.innerHeight - 48) }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setContext(undefined) } }}>
        <button type="button" role="menuitem" onClick={() => deleteDrawing(context.id)}>
          <Trash2 size={14} />{contextDrawing.tool === 'box' ? '删除方框' : '删除线条'}
        </button>
      </div>, document.body,
    )}
  </>
}

export default function MaTimeframeCharts(props: Props) {
  return props.intraday ? <IntradayCharts {...props} /> : <Chart {...props} />
}
