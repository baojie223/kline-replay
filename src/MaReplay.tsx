import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode, SetStateAction } from 'react'
import { CandlestickChart, ChevronsLeft, ChevronsRight, History, Play, Plus, X } from 'lucide-react'
import MarketSelector from './MarketSelector'
import type { IctSetup } from './ict'
import MaManualReplay from './MaManualReplay'
import {
  actionSetup, describeAction, maAnnotations, MaInspector, MaReplayStats, MaTradeLedger, setupEvidence,
} from './MaOperations'
import type { MaSeek } from './MaOperations'
import MaPlayback, { useMaPlayback } from './MaPlayback'
import MaTimeframeCharts from './MaTimeframeCharts'
import ReplayHistory from './ReplayHistory'
import { newRun } from './savedReplays'
import type { SavedReplay } from './savedReplays'
import { useReplayStorage } from './useReplayStorage'
import { readMaLibrary, saveMaRun } from './savedMaReplays'
import { maManualMarket, newMaManualSession, replayMaManual } from './maManual'
import type { MaManualSession } from './maManual'
import { maReplayStart, maWindow, parseMaMarket, recordMaReplay, withMaRolls } from './maBacktest'
import type { MaAction, MaBar, MaPeriod, MaReplayData } from './maBacktest'
import { maReplayDate } from './maTimeframes'
import type { MaReplayPoint } from './maTimeframes'

export type MaView = '5m-manual' | MaPeriod
type MaHistory = { bars: MaBar[]; start: number; minutes?: MaBar[] }

const marketFiles = {
  '1m': new URL('../research/ma-ict/market-1m.csv', import.meta.url).href,
  '5m': new URL('../research/ma-ict/market-5m.csv', import.meta.url).href,
  '1d': new URL('../research/ma-ict/market-1d.csv', import.meta.url).href,
}
const integer = new Intl.NumberFormat('zh-CN')

async function loadMarket(period: MaPeriod | '1m', signal: AbortSignal) {
  const response = await fetch(marketFiles[period], { signal })
  if (!response.ok) throw new Error('MA market ' + period + ' HTTP ' + response.status)
  return parseMaMarket(await response.text(), period)
}

async function loadHistory(period: MaPeriod, signal: AbortSignal): Promise<MaHistory> {
  let bars: MaBar[]
  let minutes: MaBar[] | undefined
  if (period === '1d') {
    bars = await loadMarket('1d', signal)
  } else {
    const [five, daily, one] = await Promise.all([loadMarket('5m', signal), loadMarket('1d', signal), loadMarket('1m', signal)])
    bars = withMaRolls(five, daily)
    if (one.length !== bars.length * 5 || bars.some((bar, index) =>
        one[index * 5 + 4].date !== bar.date || one[index * 5 + 4].contract !== bar.contract)) {
      throw new Error('MA 1-minute and 5-minute history must align')
    }
    minutes = one
  }
  const start = maReplayStart(bars)
  for (let index = Math.max(start, 1); index < bars.length; index++) {
    const { contract, tradeDate, rollFrom, rollExitOpen } = bars[index]
    const previous = bars[index - 1].contract
    if (contract !== previous && (rollFrom !== previous || rollExitOpen === undefined)) {
      throw new Error('Missing old contract open on ' + tradeDate)
    }
  }
  return { bars, start, minutes }
}

function actionsThrough(actions: MaAction[], cursor: number) {
  let start = 0
  let end = actions.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (actions[middle].index <= cursor) start = middle + 1
    else end = middle
  }
  return start
}

type ReplayFocus = { from?: number; cursor: number; setup?: IctSetup }

function PeriodReplay({ data, period, cursor, setCursor, minutes }: {
  data: MaReplayData; period: MaPeriod; cursor: number; setCursor: (value: SetStateAction<number>) => void; minutes?: MaBar[]
}) {
  const { bars, actions, frames, start, trades } = data
  const last = bars.length - 1
  const bar = bars[cursor]
  const frame = frames[cursor]
  const chartPanel = useRef<HTMLElement>(null)
  const [focus, setFocus] = useState<ReplayFocus>()
  const [date, setDate] = useState<string>()
  const [minute, setMinute] = useState<number>()
  const move = useCallback((direction: number) => {
    setMinute(undefined)
    if (minute && direction < 0) return
    setCursor((index) => Math.min(last, Math.max(start, index + direction)))
  }, [last, minute, setCursor, start])
  const playback = useMaPlayback(cursor, last, move)
  const currentDate = minute ? maReplayDate(bars, { cursor, minute }) : bar.date

  function advance(point: MaReplayPoint) {
    playback.pause()
    setMinute(point.minute)
    setCursor(point.cursor)
  }
  const visibleCount = actionsThrough(actions, cursor)
  const loggedActions = useMemo(() => actions.slice(0, visibleCount).sort((a, b) => b.index - a.index), [actions, visibleCount])
  const previousAction = loggedActions.find((action) => action.index < cursor)
  const nextAction = actions[visibleCount]
  const evidence = (focus?.cursor === cursor ? focus.setup : undefined) ??
    frame.pending ?? frame.position?.setup ?? actionSetup(actions[visibleCount - 1])
  const allMarkers = useMemo(() => maAnnotations(actions), [actions])
  const markers = useMemo(() => evidence ? [...allMarkers, ...setupEvidence(evidence)] : allMarkers, [allMarkers, evidence])
  const barActions = useMemo(() => {
    const byIndex = new Map<number, MaAction[]>()
    for (const action of actions) {
      const sameBar = byIndex.get(action.index)
      if (sameBar) sameBar.push(action)
      else byIndex.set(action.index, [action])
    }
    return byIndex
  }, [actions])
  const describeBar = useCallback((index: number) => {
    const cluster = barActions.get(index)
    return cluster && <div className="ma-chart-events">
      {cluster.map((action, offset) => {
        const { title, detail } = describeAction(action)
        return <div key={offset}><b>{title}</b> · {detail}</div>
      })}
    </div>
  }, [barActions])

  const seek: MaSeek = (index, setup) => {
    playback.pause()
    setMinute(undefined)
    setDate(undefined)
    setCursor(index)
    setFocus({ cursor: index, from: setup?.sweep.index, setup })
  }

  function seekFromLedger(index: number, setup?: IctSetup) {
    seek(index, setup)
    chartPanel.current?.focus()
  }

  function seekDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const requested = date ?? bar.tradeDate
    if (!requested) return
    const index = bars.findIndex((item, i) => i >= start && item.tradeDate >= requested)
    if (index >= 0) seek(index)
  }

  const active = frame.pending ?? frame.position?.setup
  return (
    <>
      <MaReplayStats frame={frame} />
      <div className="workspace-grid ma-grid">
        <section className="panel market-panel ma-chart" ref={chartPanel} tabIndex={-1} aria-label="甲醇 K 线回放">
          <MaPlayback bar={{ date: currentDate, contract: (minute ? bars[cursor + 1] : bar).contract }} playback={playback}
            atStart={cursor === start && !minute} atEnd={cursor === last} nextInChart={period === '5m'} />
          <div className="ma-navigation">
            <div className="ma-nav-actions" aria-label="按操作定位">
              <button type="button" className="button small" disabled={!previousAction}
                onClick={() => { if (previousAction) seek(previousAction.index, actionSetup(previousAction)) }}>
                <ChevronsLeft size={15} />上一动作
              </button>
              <button type="button" className="button small" disabled={!nextAction}
                onClick={() => { if (nextAction) seek(nextAction.index, actionSetup(nextAction)) }}>
                <ChevronsRight size={15} />下一动作
              </button>
              <button type="button" className="button small" onClick={() => seek(start)} disabled={cursor === start && !minute}>回到起点</button>
              <button type="button" className="button small" onClick={() => seek(last)} disabled={cursor === last}>查看期末</button>
            </div>
            <form className="ma-date-jump" onSubmit={seekDay}>
              <input type="date" aria-label="定位交易日" value={date ?? bar.tradeDate}
                min={maWindow.from} max={maWindow.through} onChange={(event) => setDate(event.target.value)} required />
              <button className="button small" type="submit">跳转</button>
            </form>
          </div>
          <MaTimeframeCharts bars={bars} cursor={cursor} start={start} intraday={period === '5m'} precision={0}
            drawingScope={`ict/${period}`} pausePlayback={playback.pause} minute={minute} minutes={minutes} onAdvance={advance}
            limitPrice={frame.pending?.entry} stopPrice={active?.stop} targetPrice={active?.target}
            annotations={markers} describeBar={describeBar} focus={focus} />
          <footer className="chart-footer ma-footer">
            <label className="ma-progress">
              <span className="sr-only">回放进度</span>
              <input type="range" min={start} max={last} step={1} value={cursor}
                aria-valuetext={bar.date} onChange={(event) => seek(Number(event.target.value))} />
              <span>{integer.format(cursor - start + 1)} / {integer.format(last - start + 1)} 根</span>
            </label>
            <div>北京时间 · {period === '5m' ? 'K 线标注收盘时刻' : '按交易日'} · 元/吨</div>
          </footer>
        </section>
        <MaInspector bars={bars} cursor={cursor} frame={frame} loggedActions={loggedActions} evidence={evidence} seek={seek} />
      </div>
      <MaTradeLedger trades={trades.slice(0, frame.closed)} seek={seekFromLedger} />
      <p className="ma-cost-note muted">基准撮合 · 单边万分之 1 手续费 · 市价退出滑点 1 档 · 2R 目标</p>
    </>
  )
}

function MaWorkspace({ children, actions, modalOpen = false }: {
  children: ReactNode; actions?: ReactNode; modalOpen?: boolean
}) {
  return <>
    <header className={`app-header${actions ? ' replay-header' : ''}`} inert={modalOpen}>
      <div className="brand"><div className="brand-icon"><CandlestickChart size={21} /></div><span>回放工作台</span></div>
      <div className="header-right">
        <MarketSelector market="MA" />
        {actions}
      </div>
    </header>
    <main className="workspace" inert={modalOpen}>{children}</main>
  </>
}

function NewMaReplay({ bars, earliest, start, onClose, onStart }: {
  bars: MaBar[]; earliest: number; start: number; onClose: () => void; onStart: (index: number) => void
}) {
  const [error, setError] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const date = String(new FormData(event.currentTarget).get('start'))
    const index = bars.findIndex((bar, index) => index >= earliest && bar.tradeDate >= date)
    if (index < 0 || index >= bars.length - 1) {
      setError('请选择有下一根 K 线的起始交易日。')
      return
    }
    onStart(index)
  }

  return <div className="dialog-layer" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={submit}>
      <div className="panel-heading">
        <h2 id="dialog-title">新建回放</h2>
        <button type="button" aria-label="关闭" className="icon-button" onClick={onClose}><X size={18} /></button>
      </div>
      <label>起始交易日
        <input autoFocus required name="start" type="date" defaultValue={bars[start].tradeDate}
          min={bars[earliest].tradeDate} max={bars[bars.length - 2].tradeDate} />
      </label>
      <p className="muted">非交易日顺延。当前回放会保存在「历史回放」中。</p>
      {error && <p className="negative" role="alert">{error}</p>}
      <button className="button primary" type="submit"><Play size={15} /> 开始回放</button>
    </form>
  </div>
}

function MaManualWorkspace({ bars, start: earliest, minutes }: MaHistory & { minutes: MaBar[] }) {
  const [library, setLibrary] = useState(() => readMaLibrary(bars, earliest))
  const market = useMemo(() => maManualMarket(bars, minutes), [bars, minutes])
  const [dialog, setDialog] = useState<'setup' | 'history'>()
  const { runs, activeId } = library
  const run = runs.find(({ id }) => id === activeId)!
  const modalOpen = dialog !== undefined

  const save = useCallback((item: SavedReplay<MaManualSession>) => saveMaRun(item, bars), [bars])
  const read = useCallback(() => readMaLibrary(bars, earliest), [bars, earliest])
  const { storageError, forked } = useReplayStorage('etf-replay/ma/5m/manual', run, setLibrary, save, read)

  const setSession = useCallback((update: (current: MaManualSession) => MaManualSession) => {
    setLibrary((current) => {
      if (current.activeId !== activeId) return current
      const index = current.runs.findIndex(({ id }) => id === activeId)
      const active = current.runs[index]
      const session = update(active.session)
      if (session === active.session) return current
      const runs = current.runs.slice()
      runs[index] = { ...active, session, updatedAt: Date.now() }
      return { activeId, runs }
    })
  }, [activeId])

  function createReplay(start: number) {
    const next = newRun(newMaManualSession(start))
    setLibrary((current) => ({ activeId: next.id, runs: [...current.runs, next] }))
    setDialog(undefined)
  }

  return <>
    <MaWorkspace modalOpen={modalOpen} actions={<>
      <button type="button" className="button" onClick={() => setDialog('history')}><History size={16} /> 历史回放</button>
      <button type="button" className="button" onClick={() => setDialog('setup')}><Plus size={16} /> 新建回放</button>
    </>}>
      {storageError && <p className="storage-error" role="alert">浏览器暂未保存进度。请保留当前页面，可导出成交 CSV。</p>}
      {forked && <p className="storage-error" role="status">另一标签页已更新回放。本页进度已另存，可在历史回放中查看两份记录。</p>}
      <MaManualReplay key={activeId} runId={activeId} bars={bars} market={market} session={run.session} setSession={setSession} modalOpen={modalOpen} />
    </MaWorkspace>
    {dialog === 'setup' && <NewMaReplay bars={bars} earliest={earliest} start={run.session.start}
      onClose={() => setDialog(undefined)} onStart={createReplay} />}
    {dialog === 'history' && <ReplayHistory items={runs.map(({ id, createdAt, updatedAt, session }) => ({
      id, createdAt, updatedAt, range: `${bars[session.start].date} 至 ${maReplayDate(bars, session)}`,
      summary: `${replayMaManual(bars, session, market).trades.length} 笔平仓`, detail: `起始交易日 ${bars[session.start].tradeDate}`,
    }))} activeId={activeId} onClose={() => setDialog(undefined)}
      onOpen={(id) => { setLibrary((current) => ({ ...current, activeId: id })); setDialog(undefined) }} />}
  </>
}

export default function MaReplay({ view }: { view: MaView }) {
  const period = view === '5m-manual' ? '5m' : view
  const [datasets, setDatasets] = useState<Partial<Record<MaPeriod, MaHistory>>>({})
  const [cursors, setCursors] = useState<Partial<Record<MaPeriod, number>>>({})
  const [failed, setFailed] = useState<MaPeriod>()
  const [attempt, setAttempt] = useState(0)
  const history = datasets[period]
  const manual = view === '5m-manual'
  const replay = useMemo(() => history && !manual ? recordMaReplay(history.bars, period) : undefined, [history, manual, period])

  useEffect(() => {
    if (history) return
    const controller = new AbortController()
    setFailed(undefined)
    loadHistory(period, controller.signal).then((dataset) => {
      if (!controller.signal.aborted) setDatasets((current) => ({ ...current, [period]: dataset }))
    }).catch(() => { if (!controller.signal.aborted) setFailed(period) })
    return () => controller.abort()
  }, [attempt, history, period])

  const setCursor = useCallback((value: SetStateAction<number>) => {
    if (!history) return
    setCursors((current) => {
      const previous = current[period] ?? history.start
      const next = typeof value === 'function' ? value(previous) : value
      return previous === next ? current : { ...current, [period]: next }
    })
  }, [history, period])

  if (history?.minutes && manual) return <MaManualWorkspace bars={history.bars} start={history.start} minutes={history.minutes} />
  return <MaWorkspace>
    {replay ? <PeriodReplay key={period} data={replay} period={period} cursor={cursors[period] ?? replay.start} setCursor={setCursor} minutes={history?.minutes} />
      : failed === period ? <div className="panel ma-load" role="alert">
        行情加载失败。请检查回测行情文件。 <button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
      </div> : <div className="panel ma-load" role="status">正在读取行情并生成回放…</div>}
  </MaWorkspace>
}

