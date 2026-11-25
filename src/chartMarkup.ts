import { useEffect, useMemo, useRef } from 'react'
import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical,
} from 'lightweight-charts'
import { firstCandleAt, overlappingCandles } from './maTimeframes'
import type { CandleInterval } from './maTimeframes'

export type DrawingTool = 'line' | 'box'
export type DrawingPoint = { time: number; price: number }
export type ReplayDrawing = {
  id: string
  tool: DrawingTool
  color: string
  first: DrawingPoint
  last: DrawingPoint
  revealedAt: number
}

export type ChartMarkup = {
  duration: number
  through: number
  selection?: CandleInterval
  drawings: readonly ReplayDrawing[]
  selectedId?: string
  tool?: DrawingTool
  color: string
  draft?: DrawingPoint
  selectCandle: (interval?: CandleInterval) => void
  selectDrawing: (id: string) => void
  openDrawingMenu: (id: string, x: number, y: number) => void
  drawPoint: (point: DrawingPoint) => void
  drawDrag: (first: DrawingPoint, last: DrawingPoint) => void
}

type ChartInstance = { chart: IChartApi; candles: ISeriesApi<'Candlestick'> }
type Pixel = { x: number; y: number }

function hitStroke(point: Pixel, first: Pixel, last: Pixel) {
  const dx = last.x - first.x
  const dy = last.y - first.y
  const progress = ((point.x - first.x) * dx + (point.y - first.y) * dy) / (dx * dx + dy * dy || 1)
  const t = Math.max(0, Math.min(1, progress))
  return Math.hypot(point.x - first.x - t * dx, point.y - first.y - t * dy) <= 6
}

function hitShape(tool: DrawingTool, point: Pixel, first: Pixel, last: Pixel) {
  if (tool === 'line') return hitStroke(point, first, last)
  const topRight = { x: last.x, y: first.y }
  const bottomLeft = { x: first.x, y: last.y }
  return hitStroke(point, first, topRight) || hitStroke(point, topRight, last) ||
    hitStroke(point, last, bottomLeft) || hitStroke(point, bottomLeft, first)
}

function paintShape(ctx: CanvasRenderingContext2D, tool: DrawingTool, color: string, first: Pixel, last: Pixel, selected = false) {
  ctx.strokeStyle = color
  ctx.lineWidth = selected ? 2.5 : 1.5
  if (tool === 'box') {
    ctx.fillStyle = color + '30'
    ctx.fillRect(first.x, first.y, last.x - first.x, last.y - first.y)
    ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y)
  } else {
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  }
}

export function useChartMarkup(
  instance: ChartInstance | undefined, owner: { current: ChartInstance | null },
  times: readonly number[], cursor: number, markup: ChartMarkup | undefined,
) {
  const selection = markup?.selection
  const duration = markup?.duration
  const highlight = useMemo(() => selection && duration ? overlappingCandles(times, cursor, duration, selection) : undefined,
    [times, cursor, duration, selection])
  const state = useRef({ cursor, markup, highlight })
  state.current = { cursor, markup, highlight }
  const requestRedraw = useRef<() => void>(undefined)
  const enabled = !!markup
  const drawingMode = !!markup?.tool

  useEffect(() => {
    if (!enabled || !instance) return
    const { chart, candles } = instance
    const scale = chart.timeScale()
    const pane = chart.panes()[0].getHTMLElement()
    if (!pane) return
    let hover: DrawingPoint | undefined
    let press: { id: number; pixel: Pixel; first?: DrawingPoint } | undefined
    let dragging = false

    function coordinate(index: number) { return scale.logicalToCoordinate(index as Logical) }

    function location(point: DrawingPoint): Pixel | undefined {
      const { markup, cursor } = state.current
      if (!markup || point.time > markup.through) return
      const index = firstCandleAt(times, point.time, cursor)
      if (index > cursor) return
      const x = coordinate(index)
      const next = coordinate(index + 1)
      const y = candles.priceToCoordinate(point.price)
      if (x === null || next === null || y === null) return
      const end = Math.min(times[index], markup.through)
      return { x: x - Math.min(1, (end - point.time) / markup.duration) * (next - x), y }
    }

    function drawingAt(point: Pixel, includeFill = false) {
      const options = state.current.markup
      if (!options) return
      for (let index = options.drawings.length - 1; index >= 0; index--) {
        const drawing = options.drawings[index]
        const start = location(drawing.first)
        const end = location(drawing.last)
        if (!start || !end) continue
        const inside = includeFill && drawing.tool === 'box' &&
          point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x) &&
          point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y)
        if (inside || hitShape(drawing.tool, point, start, end)) return drawing
      }
    }

    const band: IPrimitivePaneRenderer = {
      draw() {},
      drawBackground(target) {
        const range = state.current.highlight
        if (!range) return
        const first = coordinate(range.from)
        const last = coordinate(range.to)
        const next = coordinate(range.to + 1)
        if (first === null || last === null || next === null) return
        const pad = (next - last) / 2
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          ctx.fillStyle = '#f3c46c32'
          ctx.fillRect(first - pad, 0, last - first + 2 * pad, mediaSize.height)
          ctx.fillStyle = '#f3c46c9e'
          ctx.fillRect(first - pad, 0, 1, mediaSize.height)
          ctx.fillRect(last + pad - 1, 0, 1, mediaSize.height)
        })
      },
    }
    const drawings: IPrimitivePaneRenderer = {
      draw(target) {
        const options = state.current.markup
        if (!options) return
        target.useMediaCoordinateSpace(({ context: ctx }) => {
          for (const drawing of options.drawings) {
            const first = location(drawing.first)
            const last = location(drawing.last)
            if (first && last) paintShape(ctx, drawing.tool, drawing.color, first, last, options.selectedId === drawing.id)
          }
          const anchor = options.draft ?? (dragging ? press?.first : undefined)
          if (!options.tool || !anchor) return
          const first = location(anchor)
          const last = hover && location(hover)
          if (first && last) paintShape(ctx, options.tool, options.color, first, last, true)
          else if (first) {
            ctx.fillStyle = options.color
            ctx.fillRect(first.x - 3, first.y - 3, 6, 6)
          }
        })
      },
    }
    const views: IPrimitivePaneView[] = [
      { zOrder: () => 'bottom', renderer: () => band },
      { renderer: () => drawings },
    ]
    const primitive: ISeriesPrimitive = {
      attached({ requestUpdate }) { requestRedraw.current = requestUpdate },
      paneViews: () => views,
      hitTest(x, y) {
        if (state.current.markup?.tool) return null
        const shape = drawingAt({ x, y })
        return shape ? { externalId: shape.id, cursorStyle: 'pointer', zOrder: 'normal' } : null
      },
    }

    function pixel(event: MouseEvent): Pixel | undefined {
      const bounds = pane!.getBoundingClientRect()
      const x = event.clientX - bounds.left
      const y = event.clientY - bounds.top
      if (x >= 0 && y >= 0 && x < scale.width() && y < bounds.height) return { x, y }
    }

    function anchor(point: Pixel): DrawingPoint | undefined {
      const time = scale.coordinateToTime(point.x)
      const price = candles.coordinateToPrice(point.y)
      const options = state.current.markup
      if (typeof time !== 'number' || price === null || price <= 0 || !options) return
      return { time: Math.min(time, options.through), price: Math.round(price) }
    }

    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) return
      const point = pixel(event)
      if (!point) return
      dragging = false
      press = { id: event.pointerId, pixel: point, first: state.current.markup?.tool ? anchor(point) : undefined }
    }

    function move(event: PointerEvent) {
      if (!event.isPrimary || (!press && !state.current.markup?.draft)) return
      const point = pixel(event)
      if (press && point && Math.hypot(point.x - press.pixel.x, point.y - press.pixel.y) > 5) dragging = true
      if (!state.current.markup?.draft && !press?.first) return
      hover = point && anchor(point)
      requestRedraw.current?.()
    }

    function cancel() {
      press = undefined
      hover = undefined
      dragging = false
      requestRedraw.current?.()
    }

    function up(event: PointerEvent) {
      if (press?.id !== event.pointerId) return
      const first = press.first
      const point = pixel(event)
      const moved = dragging || (point && Math.hypot(point.x - press.pixel.x, point.y - press.pixel.y) > 5)
      cancel()
      const options = state.current.markup
      if (!options || !point) return
      if (options.tool) {
        const last = anchor(point)
        if (!last) return
        if (moved && !options.draft) {
          if (first) options.drawDrag(first, last)
        } else options.drawPoint(last)
        return
      }
      if (moved) return
      const hit = drawingAt(point)
      const time = scale.coordinateToTime(point.x)
      if (hit) options.selectDrawing(hit.id)
      else if (typeof time === 'number') {
        options.selectCandle({ from: time - options.duration, to: Math.min(time, options.through) })
      } else options.selectCandle()
    }

    function contextMenu(event: MouseEvent) {
      const point = pixel(event)
      const drawing = point && drawingAt(point, true)
      if (!drawing) return
      event.preventDefault()
      state.current.markup?.openDrawingMenu(drawing.id, event.clientX, event.clientY)
    }

    candles.attachPrimitive(primitive)
    pane.addEventListener('pointerdown', down)
    pane.addEventListener('pointermove', move)
    pane.addEventListener('pointerup', up)
    pane.addEventListener('pointercancel', cancel)
    pane.addEventListener('pointerleave', cancel)
    pane.addEventListener('contextmenu', contextMenu)
    return () => {
      requestRedraw.current = undefined
      pane.removeEventListener('pointerdown', down)
      pane.removeEventListener('pointermove', move)
      pane.removeEventListener('pointerup', up)
      pane.removeEventListener('pointercancel', cancel)
      pane.removeEventListener('pointerleave', cancel)
      pane.removeEventListener('contextmenu', contextMenu)
      if (owner.current === instance) candles.detachPrimitive(primitive)
    }
  }, [enabled, instance, owner, times])

  useEffect(() => {
    if (!enabled || !instance) return
    instance.chart.applyOptions({ handleScroll: {
      pressedMouseMove: !drawingMode, horzTouchDrag: !drawingMode, vertTouchDrag: !drawingMode,
    } })
  }, [drawingMode, enabled, instance])

  useEffect(() => {
    requestRedraw.current?.()
  }, [markup, highlight])

  useEffect(() => {
    if (!instance || !highlight) return
    const scale = instance.chart.timeScale()
    const visible = scale.getVisibleLogicalRange()
    if (!visible || (visible.from <= highlight.from && visible.to >= highlight.to)) return
    const width = Math.max(visible.to - visible.from, highlight.to - highlight.from + 8)
    const to = Math.min(state.current.cursor + 7, (highlight.from + highlight.to + width) / 2)
    scale.setVisibleLogicalRange({ from: to - width, to })
  }, [highlight, instance])

  return highlight
}
