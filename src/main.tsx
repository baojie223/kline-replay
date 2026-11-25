import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownLeft, ArrowUpRight, CalendarDays, CandlestickChart, ChevronRight, Download,
  History, Pause, Play, Plus, SkipBack, SkipForward, X,
} from 'lucide-react'
import Chart from './Chart'
import { OrderPriceField, ProtectionPriceFields } from './ChartTrading'
import MarketSelector from './MarketSelector'
import ReplayHistory from './ReplayHistory'
import { protectionChangeError, protectionError } from './protection'
import type { ProtectionKind, ProtectionPrices } from './protection'
import { entryLabels, priceEntry, validPriceEntry } from './entryOrder'
import type { MaView } from './MaReplay'
import StrategyPanel, { defaultRules } from './StrategyPanel'
import TakeProfitComparison, { downloadCsv } from './TakeProfitComparison'
import {
  advance, amendManualEntry, amendManualProtection, cancelManualProtection, canRewind, defaultManualTakeProfitRate, defaultSettings, defaultStopLossRate, equity, manualOrderError, markReversal,
  resolveDate, rewind, startSession, submitManualOrder, takeProfitResults, validSettings,
} from './replay'
import type { Bar, ManualBuyTiming, MarketData, Session, Side } from './replay'
import { newRun, readLibrary, saveRun } from './savedReplays'
import type { SavedReplay } from './savedReplays'
import { useReplayStorage } from './useReplayStorage'
import './style.css'

const MaReplay = lazy(() => import('./MaReplay'))

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const integer = new Intl.NumberFormat('zh-CN')
const signedMoney = (amount: number) => (amount > 0 ? '+' : '') + money.format(amount)
const tone = (value: number) => value > 0 ? 'positive' : value < 0 ? 'negative' : ''

function exportTrades(session: Session) {
  const rows = [
    ['委托日期', '成交日期', '方向', '份额', '价格', '佣金', '已实现盈亏', '逆转标记日期', '第二根阳线日期', '净收益率', '手动止盈目标', '止损目标', '自动卖出原因', '固定止盈价', '固定止损价'],
    ...session.trades.map((trade) => [
      trade.date, trade.fillDate, trade.side === 'buy' ? '买入' : '卖出', trade.quantity,
      trade.price.toFixed(3), trade.fee.toFixed(2), trade.side === 'sell' ? trade.realized.toFixed(2) : '',
      trade.reversal?.markDate ?? '', trade.reversal?.signalDate ?? '',
      trade.reversal?.netReturn !== undefined ? (trade.reversal.netReturn * 100).toFixed(2) + '%' : '',
      trade.protection || trade.takeProfitRate === undefined ? '' : `${trade.takeProfitRate.toFixed(2)}%`,
      trade.protection || trade.stopLossRate === undefined ? '' : `${trade.stopLossRate.toFixed(2)}%`,
      trade.side !== 'sell' ? '' : trade.stopLossRate !== undefined ? '止损'
        : trade.takeProfitRate !== undefined || trade.reversal ? '止盈' : '',
      trade.protection?.target ?? '', trade.protection?.stop ?? '',
    ]),
  ]
  downloadCsv('159941-成交记录.csv', rows)
}

function NewReplay({ bars, session, onClose, onStart }: {
  bars: Bar[]; session: Session; onClose: () => void; onStart: (value: Session) => void
}) {
  const [error, setError] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const settings = {
      capital: Number(form.get('capital')),
      commission: Number(form.get('commission')),
      minimum: Number(form.get('minimum')),
    }
    const index = resolveDate(bars, String(form.get('start')))
    if (index < 0 || index >= bars.length - 1 || !validSettings(settings)) {
      setError('请选择有下一交易日的起始日期，并检查资金和佣金。')
      return
    }
    onStart(startSession(index, settings))
  }

  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={submit}>
        <div className="panel-heading">
          <h2 id="dialog-title">新建回放</h2>
          <button type="button" aria-label="关闭" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <label>起始日期
          <input autoFocus required name="start" type="date" defaultValue={bars[session.start].date}
            min={bars[0].date} max={bars[bars.length - 2].date} />
        </label>
        <p className="muted">非交易日顺延。当前回放会保存在「历史回放」中。</p>
        <label>初始资金（元）
          <input required name="capital" type="number" min="1" max="1000000000" step="0.01" defaultValue={session.settings.capital} />
        </label>
        <div className="fields">
          <label>单边佣金费率（%）
            <input required name="commission" type="number" min="0" max="10" step="0.0001" defaultValue={defaultSettings.commission} />
          </label>
          <label>最低佣金（元）
            <input required name="minimum" type="number" min="0" max="10000" step="0.01" defaultValue={defaultSettings.minimum} />
          </label>
        </div>
        {error && <p className="negative" role="alert">{error}</p>}
        <button className="button primary" type="submit"><Play size={15} /> 开始回放</button>
      </form>
    </div>
  )
}

function Replay({ data, run, runs, setSession, onCreate, onOpen, storageError, forked }: {
  data: MarketData; run: SavedReplay; runs: SavedReplay[]; setSession: (update: (value: Session) => Session) => void
  onCreate: (session: Session) => void; onOpen: (id: string) => void; storageError: boolean; forked: boolean
}) {
  const { bars } = data
  const { session } = run
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [showBrooks, setShowBrooks] = useState(false)
  const [showIct, setShowIct] = useState(false)
  const [side, setSide] = useState<Side>('buy')
  const [quantity, setQuantity] = useState('1000')
  const [manualRate, setManualRate] = useState(() => String(session.manualTakeProfitRate ?? defaultManualTakeProfitRate))
  const [manualStopRate, setManualStopRate] = useState(() => String(session.manualStopLossRate ?? defaultStopLossRate))
  const [buyTiming, setBuyTiming] = useState<ManualBuyTiming>(session.manualBuyTiming ?? 'open')
  const [priceMode, setPriceMode] = useState(true)
  const [draftProtection, setDraftProtection] = useState<ProtectionPrices>()
  const [drawingEntry, setDrawingEntry] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [orderNotice, setOrderNotice] = useState('')
  const [selectedTradeMode, setTradeMode] = useState<'reversal' | 'manual'>(() =>
    session.strategy ? 'reversal' : 'manual')
  const tradeMode = session.strategy ? 'reversal' : selectedTradeMode
  const [rules, setRules] = useState(() => session.strategyRules ?? defaultRules)
  const [strategyQuantity, setStrategyQuantity] = useState(() => String(rules.quantity))
  const current = bars[session.cursor]
  const lastBar = session.cursor === bars.length - 1
  const previousAvailable = canRewind(session)
  const entry = session.pending?.entry
  const protectionTriggered = session.manualTakeProfit?.triggered || session.manualStopLoss?.triggered
  const buysAtClose = side === 'buy' && buyTiming === 'close'
  const modalOpen = showSetup || showHistory
  const canDrawEntry = tradeMode === 'manual' && !session.shares && !session.pending && !lastBar
  const placing = canDrawEntry && drawingEntry && !modalOpen
  const running = playing && !lastBar && !modalOpen
  const lastBuy = useMemo(() => session.trades.slice().reverse().find((trade) => trade.side === 'buy'), [session.trades])
  const holdingPrice = session.shares ? lastBuy?.entry ? lastBuy.price : session.cost / session.shares : undefined
  const priceOrderFilled = !!lastBuy?.entry && lastBuy.fillDate === current.date
  const value = equity(session, current.close)
  const profit = value - session.settings.capital
  const returns = profit / session.settings.capital * 100
  const realized = session.trades.reduce((sum, trade) => sum + trade.realized, 0)
  const exits = session.trades.filter((trade) => trade.side === 'sell' && trade.reversal)
  const strategyProfit = exits.reduce((sum, trade) => sum + trade.realized, 0)
  const averageReturn = exits.length
    ? exits.reduce((sum, trade) => sum + (trade.reversal?.netReturn ?? 0), 0) / exits.length
    : null
  const draftPrices = draftProtection ?? {
    target: Number((current.close * 1.01).toFixed(3)), stop: Number((current.close * 0.99).toFixed(3)),
  }
  const livePrices = session.pending?.side === 'buy' ? session.pending.protection ?? {}
    : session.shares ? { target: session.manualTakeProfit?.price, stop: session.manualStopLoss?.price }
    : priceMode ? draftPrices : {}
  const showManualProtection = tradeMode === 'manual' && !protectionTriggered && (session.shares > 0 || session.pending?.side === 'buy')
  const strategyHolding = session.strategy?.phase === 'holding' && !session.strategy.stopTriggered ? session.strategy : undefined
  const targetPrice = strategyHolding?.targetPrice ?? (showManualProtection ? livePrices.target : undefined)
  const stopPrice = strategyHolding?.stopPrice ?? (showManualProtection ? livePrices.stop : undefined)

  function changeProtection(kind: ProtectionKind, price: number | undefined) {
    const prices = { ...livePrices, [kind]: price }
    const error = session.shares && session.pending?.side !== 'buy'
      ? protectionChangeError(prices, livePrices, current.close) : protectionError(prices, entry?.price ?? current.close)
    if (error) return error
    setPlaying(false)
    if (session.shares || session.pending?.side === 'buy') {
      setSession((previous) => amendManualProtection(previous, bars, prices))
    } else { setPriceMode(true); setDraftProtection(prices) }
    setOrderNotice('')
  }

  function changeEntry(price: number | undefined) {
    if (price !== undefined) {
      if (!validPriceEntry(priceEntry(price, current.close, 1), 3)) return '挂单价需为正数，最多 3 位小数。'
      if (protectionError(livePrices, price)) return '请先调整止盈止损，使其位于新挂单价两侧。'
    }
    setPlaying(false)
    setSession((previous) => amendManualEntry(previous, bars, price))
  }

  function drawEntry() {
    setPlaying(false)
    if (placing) {
      setDrawingEntry(false)
      return
    }
    const error = manualOrderError(session, 'buy', Number(quantity), defaultManualTakeProfitRate, 'open', lastBar)
    setOrderNotice(error)
    if (error) return
    setSide('buy')
    setDrawingEntry(true)
  }

  function placePriceOrder(price: number) {
    const entry = priceEntry(price, current.close, 1)
    if (!validPriceEntry(entry, 3)) return '挂单价需为正数，最多 3 位小数。'
    const size = Number(quantity)
    const rate = session.manualTakeProfitRate ?? defaultManualTakeProfitRate
    const stopRate = session.manualStopLossRate ?? defaultStopLossRate
    const error = manualOrderError(session, 'buy', size, rate, 'open', lastBar, stopRate, { prices: {}, reference: price })
    if (error) return error
    setPlaying(false)
    setSession((previous) => previous.cursor !== session.cursor
      ? { ...previous, message: '行情已推进，请重新选价。' }
      : submitManualOrder(previous, bars, 'buy', size, rate, buyTiming, stopRate, {}, entry))
    setDrawingEntry(false)
    setOrderNotice('')
  }
  const comparisons = useMemo(() => takeProfitResults(session.trades, session.settings, bars, session.cursor),
    [session.trades, session.settings, bars, session.cursor])

  useEffect(() => {
    if (priceOrderFilled) setPlaying(false)
  }, [current.date, priceOrderFilled])

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => setSession((previous) => advance(previous, bars)), 1000 / speed)
    return () => window.clearTimeout(timer)
  }, [bars, session.cursor, running, speed, setSession])

  function step() {
    setPlaying(false)
    setDrawingEntry(false)
    setSession((previous) => advance(previous, bars))
  }

  const stepBack = useCallback(() => {
    setPlaying(false)
    setDrawingEntry(false)
    setOrderNotice('')
    setSession(rewind)
  }, [setSession])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target
      if (modalOpen || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        (target instanceof Element && target.closest('input, select, textarea, [contenteditable]'))) return
      if (event.code === 'ArrowLeft' && previousAvailable) {
        event.preventDefault()
        stepBack()
        return
      }
      if (lastBar) return
      if (event.code === 'Space') {
        if (target instanceof Element && target.closest('button, a')) return
        event.preventDefault()
        setDrawingEntry(false)
        setPlaying((active) => !active)
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault()
        setPlaying(false)
        setDrawingEntry(false)
        setSession((previous) => advance(previous, bars))
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [bars, modalOpen, lastBar, previousAvailable, setSession, stepBack])

  function openSetup() {
    setPlaying(false)
    setDrawingEntry(false)
    setShowSetup(true)
  }

  function fastForwardStrategy() {
    setPlaying(false)
    setSession((previous) => {
      const phase = previous.strategy?.phase
      if (!phase) return previous
      let next = previous
      while (next.cursor < bars.length - 1) {
        next = advance(next, bars)
        if (next.strategy?.phase !== phase || next.trades.length !== previous.trades.length) break
      }
      return next
    })
  }

  function placeOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (placing) {
      setOrderNotice(placePriceOrder(Number(new FormData(event.currentTarget).get('entryPrice'))) || '')
      return
    }
    const size = Number(quantity)
    const rate = Number(manualRate)
    const stopRate = Number(manualStopRate)
    const orderPrices = priceMode ? (session.shares ? livePrices : draftPrices) : undefined
    const error = manualOrderError(session, side, size, rate, buyTiming, lastBar, stopRate,
      orderPrices && { prices: orderPrices, reference: current.close })
    setOrderNotice(error)
    if (error) return
    setPlaying(false)
    setSession((previous) => buysAtClose && previous.cursor !== session.cursor
      ? { ...previous, message: '行情已推进，请按当前 K 线重新提交。' }
      : submitManualOrder(previous, bars, side, size, rate, buyTiming, stopRate, orderPrices))
    setDraftProtection(undefined)
  }

  return (
    <>
      <header className="app-header replay-header" inert={modalOpen}>
        <div className="brand"><div className="brand-icon"><CandlestickChart size={21} /></div><span>回放工作台</span></div>
        <div className="header-right">
          <span className="market-tag"><span /> 模拟交易</span>
          <MarketSelector market="159941" />
          <button className="button" onClick={() => { setPlaying(false); setDrawingEntry(false); setShowHistory(true) }}><History size={16} /> 历史回放</button>
          <button className="button" onClick={openSetup}><Plus size={16} /> 新建回放</button>
        </div>
      </header>
      <main className="workspace" inert={modalOpen}>
        {storageError && <p className="storage-error" role="alert">本次进度暂未保存到浏览器。请保留此页面，可导出成交和止盈对比。</p>}
        {forked && <p className="storage-error" role="status">另一标签页已更新回放。本页进度已另存，可在历史回放中查看两份记录。</p>}
        <section className="instrument">
          <div className="instrument-main">
            <div className="symbol-icon"><CandlestickChart size={26} strokeWidth={1.7} /></div>
            <div>
              <div className="instrument-meta"><b>159941</b><span>深交所</span><span>日线</span></div>
              <h1>纳指ETF广发</h1>
            </div>
          </div>
          <div className="data-window"><CalendarDays size={16} /><span>{bars[0].date} <span className="soft">—</span> {bars.at(-1)?.date}</span></div>
        </section>
        <div className="workspace-grid">
          <section className="panel market-panel" aria-label="K 线回放">
            <div className="toolbar">
              <div className="playback">
                <button className="button primary play-button" disabled={lastBar} onClick={() => { setDrawingEntry(false); setPlaying(!running) }}
                  title="空格键播放或暂停" aria-label={running ? '暂停' : '播放'}>
                  {running ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                  {running ? '暂停' : '播放'}
                </button>
                <button className="button" disabled={!previousAvailable} onClick={stepBack}
                  title={previousAvailable ? '左方向键回退一根' : '已到最早可回退的位置'}>
                  <SkipBack size={16} /> <span>上一根</span>
                </button>
                <button className="button" disabled={lastBar} onClick={step} title="右方向键逐根播放">
                  <SkipForward size={16} /> <span>下一根</span>
                </button>
                <label className="speed">
                  <span className="sr-only">播放速度</span>
                  <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                    {[0.5, 1, 2, 4, 8].map((option) => <option value={option} key={option}>{option}×</option>)}
                  </select>
                </label>
              </div>
              <div className="cursor-label">
                <span className={running ? 'status-dot active' : 'status-dot'} />
                {lastBar ? '已结束' : running ? '播放中' : '已暂停'}
                <b>{current.date}</b>
              </div>
            </div>
            <Chart bars={bars} cursor={session.cursor} start={session.start} trades={session.trades}
              showBrooks={showBrooks} showIct={showIct} markDate={session.strategy?.markDate}
              targetPrice={targetPrice} stopPrice={stopPrice} entryPrice={holdingPrice}
              limitPrice={tradeMode === 'manual' ? entry?.price : undefined}
              trading={placing || showManualProtection ? {
                onChange: changeProtection, onInteract: () => setPlaying(false),
                pending: entry ? { price: entry.price, label: `买入 · ${entryLabels[entry.type]}`, onChange: changeEntry } : undefined,
                filled: holdingPrice === undefined ? undefined : {
                  price: holdingPrice, label: lastBuy?.entry ? '买入成交' : '持仓均价', reference: current.close, direction: 1,
                },
                placement: placing ? {
                  label: '买入', reference: current.close, direction: 1,
                  onPlace: placePriceOrder, onCancel: () => setDrawingEntry(false),
                } : undefined,
              } : undefined} />
            <footer className="chart-footer">
              <span>日线 · 不复权 · <a href="https://quote.eastmoney.com/sz159941.html" target="_blank" rel="noreferrer">{data.source}</a></span>
              <span>已回放 <b>{session.cursor - session.start + 1}</b> 根</span>
              <div className="chart-overlays">
                <button type="button" className="button small brooks-toggle" aria-pressed={showBrooks}
                  title="高亮 H2、楔形牛旗、楔形底反转和区间下沿机会"
                  onClick={() => setShowBrooks((visible) => !visible)}>Brooks 入场</button>
                <button type="button" className="button small ict-toggle" aria-pressed={showIct}
                  title="圆点表示 FVG 已确认，箭头表示回踩入场。悬停 K 线查看价格与依据。"
                  onClick={() => setShowIct((visible) => !visible)}>ICT 入场</button>
              </div>
              <span className="shortcuts"><kbd>Space</kbd> 播放 / 暂停 <kbd>←</kbd> 上一根 <kbd>→</kbd> 下一根</span>
            </footer>
          </section>
          <aside className="sidebar">
            <section className="panel order-panel">
              <div className="side-picker trade-modes" aria-label="下单方式">
                <button type="button" aria-pressed={tradeMode === 'reversal'} className={tradeMode === 'reversal' ? 'selected' : ''}
                  onClick={() => { setDrawingEntry(false); setTradeMode('reversal') }}>逆转策略</button>
                <button type="button" aria-pressed={tradeMode === 'manual'} className={tradeMode === 'manual' ? 'selected' : ''}
                  disabled={!!session.strategy} onClick={() => setTradeMode('manual')}>手动下单</button>
              </div>
              {tradeMode === 'reversal' ? (
                <StrategyPanel session={session} date={current.date} lastBar={lastBar} rules={rules}
                  quantity={strategyQuantity} onQuantity={setStrategyQuantity} onRules={setRules}
                  onMark={() => {
                    setPlaying(false)
                    setSession((previous) => markReversal(previous, bars[previous.cursor],
                      { ...rules, stopLossRate: rules.stopLossRate ?? defaultStopLossRate, quantity: Number(strategyQuantity) },
                      previous.cursor === bars.length - 1))
                  }}
                  onCancel={() => {
                    setPlaying(false)
                    setSession((previous) => previous.strategy && previous.strategy.phase !== 'holding'
                      ? { ...previous, strategy: null, message: '已取消逆转信号。' } : previous)
                  }}
                  onFastForward={fastForwardStrategy} />
              ) : <>
                <div className="panel-heading">
                  <h2>模拟下单</h2>
                  <span className="pill">{entry || placing ? '触价成交' : buysAtClose ? `收盘 ¥${current.close.toFixed(3)}` : '下一交易日开盘'}</span>
                </div>
                {!entry && <form onSubmit={placeOrder} noValidate>
                  {!placing && <div className="side-picker" aria-label="交易方向">
                    <button type="button" aria-pressed={side === 'buy'} className={side === 'buy' ? 'selected buy' : ''}
                      onClick={() => { setSide('buy'); setOrderNotice('') }}><ArrowDownLeft size={16} /> 买入</button>
                    <button type="button" aria-pressed={side === 'sell'} className={side === 'sell' ? 'selected sell' : ''}
                      onClick={() => { setSide('sell'); setOrderNotice('') }}><ArrowUpRight size={16} /> 卖出</button>
                  </div>}
                  <label className={`quantity-label${placing ? ' protection-help' : ''}`}>委托份额
                    <div className="quantity-input">
                      <input type="number" min="100" step="100" value={quantity}
                        onChange={(event) => { setQuantity(event.target.value); setOrderNotice('') }} />
                      <span>份</span>
                    </div>
                  </label>
                  <div className="quantity-options">
                    {[100, 1000, 5000].map((size) =>
                      <button type="button" key={size} className={Number(quantity) === size ? 'chosen' : ''}
                        onClick={() => { setQuantity(String(size)); setOrderNotice('') }}>{integer.format(size)}</button>)}
                  </div>
                  {canDrawEntry && <div className="chart-order-actions">
                    <button type="button" className="button buy" aria-pressed={placing} onClick={drawEntry}>画线买入</button>
                  </div>}
                  {placing && <OrderPriceField precision={3} onCancel={() => { setDrawingEntry(false); setOrderNotice('') }} />}
                  {!placing && side === 'buy' && <>
                    <div className="quantity-label manual-timing">
                      <label htmlFor="manual-buy-timing">买入时点</label>
                      <select id="manual-buy-timing" value={buyTiming} onChange={(event) => {
                        setBuyTiming(event.target.value as ManualBuyTiming)
                        setOrderNotice('')
                      }}>
                        <option value="close">当天收盘</option>
                        <option value="open">下一交易日开盘</option>
                      </select>
                    </div>
                    <div className="side-picker trade-modes" aria-label="保护价设置方式">
                      <button type="button" className={priceMode ? 'selected' : ''} onClick={() => setPriceMode(true)}>固定价格</button>
                      <button type="button" className={!priceMode ? 'selected' : ''} onClick={() => setPriceMode(false)}>收益率</button>
                    </div>
                    {priceMode ? !session.pending && !session.shares && <ProtectionPriceFields prices={draftPrices} precision={3} onChange={(kind, price) => {
                      const error = changeProtection(kind, price)
                      setOrderNotice(error || '')
                      return error
                    }} /> : <div className="manual-rate">
                      <div className="fields">
                        <div className="quantity-label">
                          <label htmlFor="manual-take-profit">止盈（净收益）</label>
                          <div className="quantity-input">
                            <input id="manual-take-profit" type="number" min="1" max="10" step="0.1" value={manualRate}
                              onChange={(event) => { setManualRate(event.target.value); setOrderNotice('') }} />
                            <span>%</span>
                          </div>
                        </div>
                        <div className="quantity-label">
                          <label htmlFor="manual-stop-loss">止损（净亏损）</label>
                          <div className="quantity-input">
                            <input id="manual-stop-loss" type="number" min="1" max="10" step="0.1" value={manualStopRate}
                              onChange={(event) => { setManualStopRate(event.target.value); setOrderNotice('') }} />
                            <span>%</span>
                          </div>
                        </div>
                      </div>
                      {session.shares > 0 && <p className="strategy-hint">加仓后按全仓成本更新止盈和止损。</p>}
                    </div>}
                  </>}
                  {!placing && <button className={`button order-button ${side}`} disabled={!!session.pending || (lastBar && !buysAtClose)} type="submit">
                    {buysAtClose ? '按收盘价买入' : side === 'buy' ? '提交买入委托' : '提交卖出委托'} <ChevronRight size={16} />
                  </button>}
                </form>}
                {session.pending ? (
                  <div className="order-status" role="status">
                    <span>待成交 · {session.pending.side === 'buy' ? '买入' : '卖出'} {integer.format(session.pending.quantity)} 份
                      {entry && ` · ${entryLabels[entry.type]} ¥${entry.price.toFixed(3)}`}
                      {session.pending.protection ? (!entry || session.pending.protection.target !== undefined || session.pending.protection.stop !== undefined) &&
                        ` · 止盈 ${session.pending.protection.target ?? '未设'} / 止损 ${session.pending.protection.stop ?? '未设'}` : <>
                        {session.pending.takeProfitRate !== undefined && ` · 止盈 ${session.pending.takeProfitRate}%`}
                        {session.pending.stopLossRate !== undefined && ` · 止损 ${session.pending.stopLossRate}%`}
                      </>}</span>
                    <button className="text-button" onClick={() => {
                      if (entry) changeEntry(undefined)
                      else setSession((previous) => ({ ...previous, pending: null, message: '已撤销委托。' }))
                    }}>撤单</button>
                  </div>
                ) : (!placing || orderNotice) && <p className={`order-status ${orderNotice ? 'negative' : ''}`} role="status">
                  {orderNotice || session.message || '100 份起 · 每次可提交一笔委托'}
                </p>}
                {session.manualTakeProfit && (
                  <div className="manual-target" role="status">
                    <div>
                      <b>{session.manualTakeProfit.triggered ? '止盈待成交' : session.manualTakeProfit.fixed ? '止盈已挂' : `止盈已挂 · +${session.manualTakeProfit.rate}%`}</b>
                      <small>触发价 ¥{session.manualTakeProfit.price.toFixed(3)} · {integer.format(session.shares)} 份</small>
                    </div>
                    {!session.manualTakeProfit.triggered && <button className="text-button" onClick={() => {
                      setPlaying(false)
                      setSession((previous) => cancelManualProtection(previous, 'target'))
                    }}>撤销止盈</button>}
                  </div>
                )}
                {session.manualStopLoss && (
                  <div className="manual-target manual-stop" role="status">
                    <div>
                      <b>{session.manualStopLoss.triggered ? '止损待成交' : session.manualStopLoss.fixed ? '止损已挂' : `止损已挂 · −${session.manualStopLoss.rate}%`}</b>
                      <small>触发价 ¥{session.manualStopLoss.price.toFixed(3)} · {integer.format(session.shares)} 份</small>
                    </div>
                    {!session.manualStopLoss.triggered && <button className="text-button" onClick={() => {
                      setPlaying(false)
                      setSession((previous) => cancelManualProtection(previous, 'stop'))
                    }}>撤销止损</button>}
                  </div>
                )}
              </>}
            </section>
            <section className="panel account-panel">
              <div className="panel-heading"><h2>模拟账户</h2><span className="pill">佣金 {session.settings.commission}% / 边</span></div>
              <div className="equity"><span>账户权益</span><strong>{money.format(value)}</strong>
                <b className={tone(profit)}>{signedMoney(profit)} ({returns > 0 ? '+' : ''}{returns.toFixed(2)}%)</b>
              </div>
              <dl className="account-grid">
                <div><dt>可用现金</dt><dd>{money.format(session.cash)}</dd></div>
                <div><dt>持仓份额</dt><dd>{integer.format(session.shares)} 份</dd></div>
                <div><dt>已实现盈亏</dt><dd className={tone(realized)}>{signedMoney(realized)}</dd></div>
                <div><dt>最大回撤</dt><dd>{(session.maxDrawdown * 100).toFixed(2)}%</dd></div>
              </dl>
            </section>
          </aside>
        </div>
        <TakeProfitComparison results={comparisons} settings={session.settings} date={current.date} />
        <section className="panel history">
          <div className="panel-heading">
            <h2><History size={17} /> 成交记录 <span className="pill">{session.trades.length}</span></h2>
            <button className="button small" disabled={!session.trades.length} onClick={() => exportTrades(session)}>
              <Download size={15} /> 导出 CSV
            </button>
          </div>
          {session.trades.some((trade) => trade.reversal) && (
            <div className="strategy-summary">
              <span>逆转策略</span>
              <span>已平仓 <b>{exits.length}</b> 笔</span>
              <span>已实现盈亏 <b className={tone(strategyProfit)}>{signedMoney(strategyProfit)}</b></span>
              <span>平均每笔净收益 <b className={tone(averageReturn ?? 0)}>{averageReturn === null ? '—' : `${(averageReturn * 100).toFixed(2)}%`}</b></span>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr>{['成交日期', '方向', '成交价', '份额', '佣金', '已实现盈亏', '策略净收益'].map((label) => <th key={label}>{label}</th>)}</tr></thead>
              <tbody>
                {!session.trades.length && <tr><td colSpan={7} className="empty">暂无成交</td></tr>}
                {session.trades.slice().reverse().map((trade, index) => (
                  <tr key={session.trades.length - 1 - index}>
                    <td>{trade.fillDate}</td>
                    <td className={trade.side === 'buy' ? 'positive' : 'negative'}>
                      {trade.side === 'buy' ? '买入' : trade.stopLossRate !== undefined ? '止损卖出'
                        : trade.takeProfitRate === undefined ? '卖出' : '止盈卖出'}
                    </td>
                    <td>¥{trade.price.toFixed(3)}</td><td>{integer.format(trade.quantity)}</td>
                    <td>{money.format(trade.fee)}</td>
                    <td className={tone(trade.realized)}>{trade.side === 'buy' ? '—' : signedMoney(trade.realized)}</td>
                    <td className={tone(trade.reversal?.netReturn ?? 0)}>{trade.reversal?.netReturn === undefined
                      ? '—' : `${(trade.reversal.netReturn * 100).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      {showSetup && <NewReplay bars={bars} session={session} onClose={() => setShowSetup(false)} onStart={onCreate} />}
      {showHistory && <ReplayHistory items={runs.map(({ id, createdAt, updatedAt, session }) => ({
        id, createdAt, updatedAt, range: `${bars[session.start].date} 至 ${bars[session.cursor].date}`,
        summary: `${session.trades.length} 笔成交`, detail: `佣金 ${session.settings.commission}% / 边`,
      }))} activeId={run.id} onClose={() => setShowHistory(false)}
        onOpen={(id) => { setShowHistory(false); onOpen(id) }} />}
    </>
  )
}

function ReplayWorkspace({ data }: { data: MarketData }) {
  const [library, setLibrary] = useState(() => readLibrary(data.bars))
  const { activeId, runs } = library
  const run = runs.find((item) => item.id === activeId)!
  const save = useCallback((item: SavedReplay) => saveRun(item, data.bars), [data.bars])
  const read = useCallback(() => readLibrary(data.bars), [data.bars])
  const { storageError, forked } = useReplayStorage('etf-replay/159941', run, setLibrary, save, read)

  const setSession = useCallback((update: (value: Session) => Session) => {
    setLibrary((previous) => {
      if (previous.activeId !== activeId) return previous
      const index = previous.runs.findIndex((item) => item.id === activeId)
      const current = previous.runs[index]
      const session = update(current.session)
      if (session === current.session) return previous
      const runs = previous.runs.slice()
      runs[index] = { ...current, session, updatedAt: Date.now() }
      return { ...previous, runs }
    })
  }, [activeId])

  function createReplay(session: Session) {
    const next = newRun(session)
    setLibrary((previous) => ({ activeId: next.id, runs: [...previous.runs, next] }))
  }

  return <Replay key={activeId} data={data} run={run} runs={runs} setSession={setSession} storageError={storageError} forked={forked}
    onOpen={(id) => setLibrary((previous) => ({ ...previous, activeId: id }))} onCreate={createReplay} />
}

function EtfApp() {
  const [data, setData] = useState<MarketData>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}data/159941.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
      })
      .then((market: MarketData) => {
        if (market.symbol !== '159941' || market.bars.length < 2) throw new Error('Invalid market data')
        setData(market)
      })
      .catch(() => { if (!controller.signal.aborted) setError('行情加载失败，请检查项目中的行情文件后刷新。') })
    return () => controller.abort()
  }, [])
  return data ? <ReplayWorkspace data={data} /> : <main className="loading" role="status">{error || '正在加载 159941 行情…'}</main>
}

function selectedMaView(): MaView | undefined {
  if (location.hash === '#ma-5m-manual') return '5m-manual'
  if (location.hash === '#ma-5m') return '5m'
  if (location.hash === '#ma-1d') return '1d'
}

function App() {
  const [view, setView] = useState(selectedMaView)
  useEffect(() => {
    const onHashChange = () => setView(selectedMaView())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return view ? <Suspense fallback={<main className="loading" role="status">正在读取甲醇回测…</main>}>
    <MaReplay view={view} />
  </Suspense> : <EtfApp />
}

const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><App /></StrictMode>)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
