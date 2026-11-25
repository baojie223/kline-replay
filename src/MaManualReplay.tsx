import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import type { ChartAnnotation } from './Chart'
import { OrderPriceField, ProtectionPriceFields } from './ChartTrading'
import { MaReplayStats, money, pnlTone, signedMoney } from './MaOperations'
import MaPlayback, { useMaPlayback } from './MaPlayback'
import MaTimeframeCharts from './MaTimeframeCharts'
import { downloadCsv } from './TakeProfitComparison'
import { maLotSize } from './maBacktest'
import type { MaBar } from './maBacktest'
import {
  advanceMaManual, maMaxMarketLots, replayMaManual, stepMaManual, validMaManualOpen,
} from './maManual'
import type { maManualMarket, MaManualCommand, MaManualExit, MaManualPosition, MaManualSession, MaManualSide, MaManualTrade } from './maManual'
import { protectionChangeError, protectionError } from './protection'
import type { ProtectionKind, ProtectionPrices } from './protection'
import { entryLabels, priceEntry, validPriceEntry } from './entryOrder'
import type { MaChartPeriod, MaReplayPoint } from './maTimeframes'

type ManualFrame = ReturnType<typeof replayMaManual>
const sideLabels = { long: '多', short: '空' }
const exitLabels: Record<MaManualExit, string> = {
  manual: '手动平仓', stop: '止损', target: '止盈', roll: '换月平仓', sample_end: '期末平仓',
}
const ledgerColumns = ['合约', '方向', '手数', '开仓 K 线', '开仓价', '平仓 K 线', '平仓价', '原因', '滑点前毛盈亏', '手续费', '滑点', '净盈亏']

function entryMarker({ side, entryIndex: index, entryDate: marketTime }: MaManualPosition): ChartAnnotation {
  return side === 'long'
    ? { index, marketTime, position: 'belowBar', shape: 'arrowUp', color: '#84dbff', text: '开多' }
    : { index, marketTime, position: 'aboveBar', shape: 'arrowDown', color: '#f1a4e0', text: '开空' }
}

function manualMarkers(trades: MaManualTrade[], position?: MaManualPosition): ChartAnnotation[] {
  const markers: ChartAnnotation[] = []
  for (const trade of trades) {
    const index = trade.exitIndex
    const marketTime = trade.exitDate
    const color = trade.reason === 'stop' ? '#f1717e' : '#b8bfff'
    markers.push(entryMarker(trade), {
      index, marketTime, position: trade.side === 'long' ? 'aboveBar' : 'belowBar', shape: 'square', size: 0.65,
      color, text: exitLabels[trade.reason],
    })
    if (trade.reason !== 'roll') markers.push({ index, marketTime, position: 'atPriceMiddle', price: trade.exitPrice, shape: 'circle', color, size: 0.65 })
  }
  if (position) markers.push(entryMarker(position))
  return markers
}

function ManualOrders({ frame, bar, atEnd, orderPeriod, submit, side, onSide, prices, onPresetChange,
  lots, onLots, error, onOpen, drawingSide, onDraw, onCancelDraw, onRemoveProtection }: {
  frame: ManualFrame; bar: MaBar; atEnd: boolean; orderPeriod: MaChartPeriod; submit: (command: MaManualCommand) => void
  side: MaManualSide; onSide: (side: MaManualSide) => void; prices: ProtectionPrices
  onPresetChange: (kind: ProtectionKind, price: number | undefined) => string | void
  lots: string; onLots: (lots: string) => void; error: string; onOpen: (price?: number) => void
  drawingSide?: MaManualSide; onDraw: (side: MaManualSide) => void
  onCancelDraw: () => void; onRemoveProtection: (kind: ProtectionKind) => void
}) {
  const { pending, position, unrealized, notice } = frame

  return (
    <aside className="ma-inspector" aria-label="甲醇模拟交易">
      <section className="panel order-panel">
        <div className="panel-heading"><h2>模拟下单</h2><span className="pill">{bar.contract}</span></div>
        {position && <>
          <div className="ma-manual-holding">
            <b>持{sideLabels[position.side]} {position.lots} 手</b>
            <b className={pnlTone(unrealized)}>{signedMoney(unrealized)}</b>
          </div>
          <dl className="ma-values">
            <div><dt>开仓价</dt><dd>{position.entryPrice}</dd></div>
            <div><dt>止损触发价</dt><dd>{position.deferredExit === 'target' || position.stop === undefined ? '—' : <>
              {position.stop} <span className="muted">{position.rules?.stop?.period ?? position.period ?? 5}m</span>
            </>}</dd></div>
            <div><dt>止盈触发价</dt><dd>{position.deferredExit === 'stop' || position.target === undefined ? '—' : <>
              {position.target} <span className="muted">{position.rules?.target?.period ?? position.period ?? 5}m</span>
            </>}</dd></div>
          </dl>
          {!atEnd && !position.deferredExit && <>
            <p className="ma-state-note">从成交线拖出止盈或止损。</p>
            <div className="protection-actions">
              {position.stop !== undefined && <button className="text-button" type="button" onClick={() => onRemoveProtection('stop')}>撤销止损</button>}
              {position.target !== undefined && <button className="text-button" type="button" onClick={() => onRemoveProtection('target')}>撤销止盈</button>}
            </div>
          </>}
        </>}
        {pending ? <div className="ma-manual-actions">
          <p role="status" className="strategy-hint">
            {pending.kind === 'open' ? `开${sideLabels[pending.side]} ${pending.lots} 手` : '平仓'} ·
            {` ${pending.kind === 'open' ? pending.period ?? 5 : 5}m · `}
            {pending.kind === 'open' && pending.entry ? `${entryLabels[pending.entry.type]} ${pending.entry.price} · 等待触价` : '待下根可成交 K 线开盘'}
          </p>
          <button type="button" className="button small" onClick={() => submit({ kind: 'cancel' })}>撤单</button>
        </div> : position || atEnd ? (
          !atEnd && <button type="button" className="button order-button ma-close" onClick={() => submit({ kind: 'close' })}>委托平仓</button>
        ) : <form noValidate onSubmit={(event) => {
          event.preventDefault()
          onOpen(drawingSide ? Number(new FormData(event.currentTarget).get('entryPrice')) : undefined)
        }}>
          <label className="quantity-label protection-help">手数
            <input type="number" required min="1" max={maMaxMarketLots} step="1" value={lots} onChange={(event) => onLots(event.target.value)} />
          </label>
          <div className="chart-order-actions" role="group" aria-label="画线下单">
            <button type="button" className="button buy" aria-pressed={drawingSide === 'long'} onClick={() => onDraw('long')}>画线做多</button>
            <button type="button" className="button sell" aria-pressed={drawingSide === 'short'} onClick={() => onDraw('short')}>画线做空</button>
          </div>
          {drawingSide ? <>
            <p className="ma-state-note">按 {orderPeriod} 分钟 K 线撮合</p>
            <OrderPriceField precision={0} onCancel={onCancelDraw} />
          </> : <>
            <div className="ma-state-badge">市价下单</div>
            <div className="side-picker" aria-label="开仓方向">
              <button type="button" aria-pressed={side === 'long'} className={side === 'long' ? 'selected buy' : ''}
                onClick={() => onSide('long')}>做多</button>
              <button type="button" aria-pressed={side === 'short'} className={side === 'short' ? 'selected sell' : ''}
                onClick={() => onSide('short')}>做空</button>
            </div>
            <ProtectionPriceFields prices={prices} precision={0} onChange={onPresetChange} />
            <button className={'button order-button ' + (side === 'long' ? 'buy' : 'sell')} type="submit">
              委托开{sideLabels[side]} <span>下根开盘</span>
            </button>
          </>}
        </form>}
        {error && <p className="order-status negative" role="alert">{error}</p>}
        {position?.deferredExit && !atEnd && <p className="ma-state-note" role="status">{exitLabels[position.deferredExit]}已触发，等待可成交开盘。</p>}
        {notice && <p className="ma-state-note" role="status">{notice}</p>}
        {atEnd && <p className="ma-state-note">已到行情末尾。{position && '持仓按最后收盘价估值。'}</p>}
      </section>
    </aside>
  )
}

function ManualLedger({ trades, bars }: { trades: MaManualTrade[]; bars: MaBar[] }) {
  function exportTrades() {
    downloadCsv('甲醇-5分钟-回测成交.csv', [ledgerColumns, ...trades.map((trade) => [
      trade.contract, sideLabels[trade.side], trade.lots, trade.entryDate ?? bars[trade.entryIndex].date, trade.entryPrice,
      trade.exitDate ?? bars[trade.exitIndex].date, trade.exitPrice, exitLabels[trade.reason],
      trade.gross.toFixed(2), trade.fees.toFixed(2), trade.slippage.toFixed(2), trade.net.toFixed(2),
    ])])
  }

  return <section className="panel history ma-ledger">
    <div className="panel-heading">
      <h2>逐笔成交</h2>
      <button type="button" className="button small" disabled={!trades.length} onClick={exportTrades}><Download size={15} />导出 CSV</button>
    </div>
    <div className="table-wrap">
      <table>
        <thead><tr>{ledgerColumns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {!trades.length && <tr><td className="empty" colSpan={ledgerColumns.length}>平仓后显示成交明细</td></tr>}
          {trades.slice().reverse().map((trade) => <tr key={trade.entryDate ?? bars[trade.entryIndex].date}>
            <td>{trade.contract}</td><td>{sideLabels[trade.side]}</td><td>{trade.lots}</td>
            <td>{trade.entryDate ?? bars[trade.entryIndex].date} <span className="muted">{trade.period ?? 5}m</span></td><td>{trade.entryPrice}</td>
            <td>{trade.exitDate ?? bars[trade.exitIndex].date} <span className="muted">{trade.exitPeriod ?? 5}m</span></td><td>{trade.exitPrice}</td><td>{exitLabels[trade.reason]}</td>
            <td>{money(trade.gross)}</td><td>{money(trade.fees)}</td><td>{money(trade.slippage)}</td>
            <td className={pnlTone(trade.net)}>{signedMoney(trade.net)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>
}

export default function MaManualReplay({ runId, bars, market, session, setSession, modalOpen }: {
  runId: string; bars: MaBar[]; session: MaManualSession
  market: ReturnType<typeof maManualMarket>
  setSession: (update: (current: MaManualSession) => MaManualSession) => void; modalOpen: boolean
}) {
  const [side, setSide] = useState<MaManualSide>('long')
  const [lots, setLots] = useState('1')
  const [orderError, setOrderError] = useState('')
  const [draft, setDraft] = useState<ProtectionPrices>()
  const [drawingSide, setDrawingSide] = useState<MaManualSide>()
  const [orderPeriod, setOrderPeriod] = useState<MaChartPeriod>(5)
  const { start, cursor, minute } = session
  const bar = minute ? market.minutes[cursor * 5 + minute + 4] : bars[cursor]
  const last = bars.length - 1
  const move = useCallback((direction: number) => {
    setDrawingSide(undefined)
    setOrderError('')
    setSession((current) => stepMaManual(current, bars, direction))
  }, [bars, setSession])
  const playback = useMaPlayback(cursor, last, move, modalOpen)
  const { pause } = playback
  function advance(point: MaReplayPoint) {
    pause()
    setDrawingSide(undefined)
    setOrderError('')
    setSession((current) => advanceMaManual(current, bars, point))
  }
  const frame = useMemo(() => replayMaManual(bars, session, market), [bars, market, session])
  const { position, trades, realized, unrealized, maxDrawdown, priceOrderFilled } = frame
  const pending = frame.pending?.kind === 'open' ? frame.pending : undefined
  const showProtection = !!(position || pending) && !position?.deferredExit
  const placing = !modalOpen && !frame.pending && !position && cursor < last ? drawingSide : undefined
  const direction = (pending?.side ?? position?.side ?? side) === 'long' ? 1 : -1
  const entry = pending?.entry
  const prices = pending ? pending.protection ?? {
    stop: pending.stopTicks === undefined ? undefined : bar.close - direction * pending.stopTicks,
    target: pending.targetTicks === undefined ? undefined : bar.close + direction * pending.targetTicks,
  } : position ? { stop: position.stop, target: position.target } : draft ?? {
    stop: bar.close - direction * 10, target: bar.close + direction * 20,
  }

  function changeProtection(kind: ProtectionKind, price: number | undefined, period?: MaChartPeriod) {
    const next = { ...prices, [kind]: price }
    const error = position ? protectionChangeError(next, prices, bar.close, direction, 0)
      : protectionError(next, entry?.price ?? bar.close, direction, 0)
    if (error) return error
    playback.pause()
    if (position || pending) submit({ kind: 'protection', prices: next, period })
    else setDraft(next)
  }

  function changeEntry(price: number, period?: MaChartPeriod) {
    if (!validPriceEntry(priceEntry(price, bar.close, direction), 0)) return '挂单价需为正整数。'
    if (protectionError(prices, price, direction, 0)) return '请先调整止盈止损，使其位于新挂单价两侧。'
    submit({ kind: 'entry', price, period })
  }

  function drawEntry(nextSide: MaManualSide) {
    playback.pause()
    const valid = validMaManualOpen({ kind: 'open', side: nextSide, lots: Number(lots) })
    setOrderError(valid ? '' : `请输入 1–${maMaxMarketLots} 手的整数。`)
    setDrawingSide(valid && placing !== nextSide ? nextSide : undefined)
  }

  function openPosition(orderSide: MaManualSide, price?: number, period = orderPeriod) {
    const direction = orderSide === 'long' ? 1 : -1
    const entry = price === undefined ? undefined : priceEntry(price, bar.close, direction)
    if (entry && !validPriceEntry(entry, 0)) return '挂单价需为正整数。'
    const order = { kind: 'open' as const, side: orderSide, lots: Number(lots), entry, protection: entry ? {} : prices,
      ...(entry && { period }) }
    if (!validMaManualOpen(order)) return `手数填 1–${maMaxMarketLots} 的整数，价格填正整数。`
    const error = protectionError(order.protection, entry?.price ?? bar.close, direction, 0)
    if (error) return error
    submit(order)
  }
  const markers = useMemo(() => manualMarkers(trades, position), [trades, position])

  useEffect(() => {
    if (priceOrderFilled || modalOpen) pause()
    if (modalOpen) setDrawingSide(undefined)
  }, [cursor, minute, priceOrderFilled, modalOpen, pause])

  function submit(command: MaManualCommand) {
    playback.pause()
    if (cursor === last) return
    if (command.kind === 'open') {
      setDraft(undefined)
      setDrawingSide(undefined)
      setOrderError('')
    }
    setSession((current) => current === session
      ? { ...current, commands: [...current.commands, { ...command, at: bar.date }] }
      : current)
  }

  return <>
    <MaReplayStats frame={{
      equity: realized + unrealized, realized, maxDrawdown, closed: trades.length, wins: trades.filter((trade) => trade.net > 0).length,
    }} />
    <div className="workspace-grid ma-grid">
      <section className="panel market-panel ma-chart ma-manual-chart" aria-label="甲醇 K 线回放">
        <MaPlayback bar={bar}
          playback={playback} atStart={cursor === start && !minute} atEnd={cursor === last} nextInChart />
        <MaTimeframeCharts bars={bars} cursor={cursor} start={start} intraday precision={0}
          drawingScope={`manual/${runId}`} pausePlayback={playback.pause} minute={minute} minutes={market.minutes}
          onAdvance={advance} onActivePeriod={setOrderPeriod}
          stopPrice={showProtection ? prices.stop : undefined}
          targetPrice={showProtection ? prices.target : undefined}
          annotations={markers} entryPrice={position?.entryPrice} limitPrice={entry?.price}
          trading={cursor !== last && (placing || showProtection) ? {
            onChange: changeProtection, onInteract: playback.pause,
            pending: pending && entry ? { price: entry.price, label: `开${sideLabels[pending.side]} · ${entryLabels[entry.type]}`, onChange: changeEntry } : undefined,
            filled: position ? {
              price: position.entryPrice, label: `开${sideLabels[position.side]}成交`, reference: bar.close, direction,
            } : undefined,
            placement: placing ? {
              label: `做${sideLabels[placing]}`, reference: bar.close, direction: placing === 'long' ? 1 : -1,
              onPlace: (price, period = orderPeriod) => openPosition(placing, price, period), onCancel: () => setDrawingSide(undefined),
            } : undefined,
          } : undefined} />
        <footer className="chart-footer ma-footer">
          <span>北京时间 · 收盘时刻 · 元/吨</span>
          <span>已回放 <b>{(cursor - start + 1).toLocaleString('zh-CN')}</b> / {(last - start + 1).toLocaleString('zh-CN')} 根</span>
        </footer>
      </section>
      <ManualOrders frame={frame} bar={bar} atEnd={cursor === last} orderPeriod={orderPeriod} submit={submit} side={side} prices={prices}
        lots={lots} onLots={(value) => { setLots(value); setOrderError('') }} error={orderError}
        onOpen={(price) => setOrderError(openPosition(placing ?? side, price) || '')} drawingSide={placing} onDraw={drawEntry}
        onCancelDraw={() => { setDrawingSide(undefined); setOrderError('') }}
        onRemoveProtection={(kind) => setOrderError(changeProtection(kind, undefined) || '')}
        onSide={(value) => { playback.pause(); setSide(value); setDraft(undefined); setOrderError('') }}
        onPresetChange={(kind, price) => {
          const error = changeProtection(kind, price)
          setOrderError(error || '')
          return error
        }} />
    </div>
    <ManualLedger trades={trades} bars={bars} />
    <p className="ma-cost-note muted">{maLotSize} 吨/手 · 手续费单边万分之 1 · 止盈止损按对手价模拟 · 允许隔夜</p>
  </>
}
