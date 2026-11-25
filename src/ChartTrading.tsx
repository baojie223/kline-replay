import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { entryLabels, priceEntry } from './entryOrder'
import type { ProtectionKind, ProtectionPrices } from './protection'

type PriceContext = { label: string; reference: number; direction: 1 | -1 }
type ChangePrice = (price: number) => string | void

export type ChartTradingOptions = {
  onChange: (kind: ProtectionKind, price: number) => string | void
  onInteract: () => void
  pending?: { price: number; label: string; onChange: ChangePrice }
  filled?: PriceContext & { price: number }
  placement?: PriceContext & { onPlace: (price: number) => string | void; onCancel: () => void }
}

type LineKind = ProtectionKind | 'pending' | 'filled'
type Drag = { pointerId: number; startY: number }
const labels = { target: '止盈', stop: '止损' }
const protectionKinds = ['target', 'stop'] as const

export function ProtectionPriceFields({ prices, precision, onChange }: {
  prices: ProtectionPrices; precision: number; onChange: (kind: ProtectionKind, price: number | undefined) => string | void
}) {
  const tick = 10 ** -precision
  return <div className="protection-price-fields">
    {protectionKinds.map((kind) => {
      const formatted = prices[kind]?.toFixed(precision) ?? ''
      return <label key={kind} className="quantity-label">{labels[kind]}预设
        <input key={formatted} type="number" min={tick} step={tick} placeholder="未设置" defaultValue={formatted}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
          }}
          onBlur={({ currentTarget: input }) => {
            const value = input.value === '' ? undefined : Number(input.value)
            if (input.validity.badInput || (value !== prices[kind] && onChange(kind, value))) input.value = formatted
          }} />
      </label>
    })}
  </div>
}

export function OrderPriceField({ precision, onCancel }: { precision: number; onCancel: () => void }) {
  const tick = 10 ** -precision
  return <div className="chart-order-price">
    <p className="strategy-hint">点选 K 线上的价格即可挂单。</p>
    <label className="quantity-label">挂单价
      <input type="number" name="entryPrice" placeholder="输入精确价格" min={tick} step={tick} />
    </label>
    <div className="chart-order-price-actions">
      <button className="button small" type="submit">挂单</button>
      <button className="text-button" type="button" onClick={onCancel}>取消选价</button>
    </div>
  </div>
}

function protectionAt(price: number, context: PriceContext) {
  const distance = (price - context.reference) * context.direction
  return distance > 0 ? 'target' : distance < 0 ? 'stop' : undefined
}

export default function ChartTrading({ chart, candles, host, prices, precision, options }: {
  chart: IChartApi; candles: ISeriesApi<'Candlestick'>; host: RefObject<HTMLDivElement | null>
  prices: ProtectionPrices; precision: number; options: ChartTradingOptions
}) {
  const { pending, filled, placement } = options
  const [error, setError] = useState('')
  const [pickerPrice, setPickerPrice] = useState<number>()
  const [dragPrice, setDragPrice] = useState<{ kind: LineKind; price: number }>()
  const drag = useRef<Drag>(undefined)
  const cancelPlacement = placement?.onCancel
  const placing = !!placement
  const linePrices = { ...prices, pending: pending?.price, filled: filled?.price }
  const latestPrices = useRef(linePrices)
  latestPrices.current = linePrices
  const [pane, setPane] = useState<{ width: number; height: number; y: Partial<Record<LineKind, number>> }>({
    width: 0, height: 0, y: {},
  })

  useEffect(() => {
    let last = { width: 0, height: 0, y: {} as typeof pane.y }
    let frame: number
    function updatePane() {
      const width = chart.timeScale().width()
      const height = chart.panes()[0]?.getHeight() ?? 0
      const values = latestPrices.current
      const y = { target: at(values.target), stop: at(values.stop), pending: at(values.pending), filled: at(values.filled) }
      if (width !== last.width || height !== last.height || (Object.keys(y) as LineKind[]).some((kind) => y[kind] !== last.y[kind])) {
        last = { width, height, y }
        setPane(last)
      }
      frame = requestAnimationFrame(updatePane)
    }
    function at(price?: number) {
      return price === undefined ? undefined : candles.priceToCoordinate(price) ?? undefined
    }
    frame = requestAnimationFrame(updatePane)
    return () => cancelAnimationFrame(frame)
  }, [chart, candles])

  useEffect(() => {
    if (placing) host.current?.scrollIntoView({ block: 'nearest' })
  }, [host, placing])

  useEffect(() => {
    function cancel(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      cancelPlacement?.()
      setPickerPrice(undefined)
      setDragPrice(undefined)
      drag.current = undefined
      setError('')
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [cancelPlacement])

  function priceAt(clientY: number) {
    const top = host.current?.getBoundingClientRect().top
    if (top === undefined) return
    const y = clientY - top
    if (y < 0 || y > pane.height) return
    const price = candles.coordinateToPrice(y)
    return price === null ? undefined : Number(price.toFixed(precision))
  }

  function commit(kind: LineKind, price: number) {
    let message: string | void = undefined
    if (kind === 'filled') {
      const protection = filled && protectionAt(price, filled)
      message = protection ? options.onChange(protection, price) : '请拖到当前价上方或下方一档。'
    } else if (price !== linePrices[kind]) {
      message = kind === 'pending' ? pending?.onChange(price) : options.onChange(kind, price)
    }
    setError(message || '')
  }

  function movedPrice({ pointerId, clientY }: ReactPointerEvent) {
    const active = drag.current
    if (active?.pointerId !== pointerId || Math.abs(clientY - active.startY) < 4) return
    return priceAt(clientY)
  }

  function clearDrag() {
    drag.current = undefined
    setDragPrice(undefined)
  }

  const tick = 10 ** -precision
  const lines = [
    { kind: 'pending', label: pending?.label },
    { kind: 'filled', label: filled?.label },
    ...protectionKinds.map((kind) => ({ kind, label: labels[kind] })),
  ] as const
  const previewPrice = dragPrice?.price ?? (placement ? pickerPrice : undefined)
  const previewY = previewPrice === undefined ? null : candles.priceToCoordinate(previewPrice)
  const previewKind = dragPrice?.kind === 'filled' && filled && previewPrice !== undefined
    ? protectionAt(previewPrice, filled) : dragPrice?.kind
  let previewLabel: string | undefined
  if (previewPrice !== undefined) {
    if (placement) previewLabel = `${placement.label} · ${entryLabels[priceEntry(previewPrice, placement.reference, placement.direction).type]}`
    else if (previewKind === 'target' || previewKind === 'stop') previewLabel = labels[previewKind]
    else if (previewKind === 'pending') previewLabel = '挂单'
  }

  return <>
    <div className="trade-lines" style={{ width: pane.width, height: pane.height }}>
      {lines.map(({ kind, label }) => {
        const y = pane.y[kind]
        const price = linePrices[kind]
        if (y === undefined || y < 0 || y > pane.height || price === undefined || placement) return null
        return <button key={kind} type="button" className={`trade-line ${kind}`} style={{ top: y }}
          aria-label={kind === 'filled' ? '拖动成交线设置止盈止损' : `拖动${kind === 'pending' ? '挂单' : label}线`}
          title={kind === 'filled' ? '拖出止盈或止损' : '上下拖动改价 · 方向键微调'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            options.onInteract()
            setError('')
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { pointerId: event.pointerId, startY: event.clientY }
          }} onPointerMove={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return
            const price = movedPrice(event)
            setDragPrice(price === undefined ? undefined : { kind, price })
          }} onPointerUp={(event) => {
            const price = movedPrice(event)
            if (price !== undefined) commit(kind, price)
            clearDrag()
          }} onLostPointerCapture={clearDrag}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            options.onInteract()
            const base = kind === 'filled' ? filled!.reference : price
            commit(kind, Number((base + (event.key === 'ArrowUp' ? tick : -tick)).toFixed(precision)))
          }}>
          <span>↕ {label} {price.toFixed(precision)}</span>
        </button>
      })}
      {previewLabel && previewY !== null && <div className={`trade-line preview ${previewKind ?? 'pending'}`} style={{ top: previewY }}>
        <span>{previewLabel} {previewPrice?.toFixed(precision)}</span>
      </div>}
      {placement && <div className="chart-price-picker"
        onPointerMove={(event) => setPickerPrice(priceAt(event.clientY))}
        onPointerLeave={() => setPickerPrice(undefined)}
        onClick={(event) => {
          const price = priceAt(event.clientY)
          if (price !== undefined) setError(placement.onPlace(price) || '')
        }} />}
    </div>
    {error && <p className="chart-order-error" role="alert">{error}</p>}
  </>
}
