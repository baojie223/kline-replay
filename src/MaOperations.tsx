import { useEffect, useRef } from 'react'
import type { ChartAnnotation } from './Chart'
import { ictRetestWindow } from './ict'
import type { IctSetup } from './ict'
import type { MaAction, MaBar, MaCancelReason, MaExitReason, MaFrame, MaSkipReason, MaTrade } from './maBacktest'

const cny = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
export const money = (value: number) => cny.format(value)
export const signedMoney = (value: number) => (value > 0 ? '+' : '') + money(value)
export const pnlTone = (value: number) => value > 0 ? 'positive' : value < 0 ? 'negative' : ''
const side = { long: '多', short: '空' }

export function MaReplayStats({ frame }: { frame: Pick<MaFrame, 'equity' | 'realized' | 'maxDrawdown' | 'closed' | 'wins'> }) {
  return (
    <dl className="panel ma-stats" aria-label="截至当前 K 线的回测统计">
      <div><dt>收盘净盈亏</dt><dd className={pnlTone(frame.equity)}>{signedMoney(frame.equity)}</dd></div>
      <div><dt>已实现净盈亏</dt><dd className={pnlTone(frame.realized)}>{signedMoney(frame.realized)}</dd></div>
      <div><dt>最大回撤</dt><dd>{money(frame.maxDrawdown)}</dd></div>
      <div><dt>已平仓 / 净胜率</dt><dd>{frame.closed} 笔 <small>{frame.closed ? (100 * frame.wins / frame.closed).toFixed(1) + '%' : '—'}</small></dd></div>
    </dl>
  )
}

export type MaSeek = (index: number, setup?: IctSetup) => void

const exitLabels: Record<MaExitReason, string> = {
  stop: '止损', target: '止盈', day_end: '日终平仓', time: '到期平仓', roll: '换月平仓', sample_end: '期末平仓',
}
const timingLabels = { open: '该根开盘', intrabar: '盘中触发', close: '该根收盘' }
const cancelLabels: Record<MaCancelReason, string> = {
  expired: '5 根内未成交', invalidated: '开盘触及或越过止损', day_end: '交易日结束', roll: '合约切换', sample_end: '回测期末',
}
const skipLabels: Record<MaSkipReason, string> = {
  holding: '已有持仓', pending: '已有委托', day_end: '交易日结束', sample_end: '回测期末', same_bar: '同根已有信号',
}

export function actionSetup(action?: MaAction) {
  if (!action || action.kind === 'roll') return
  return action.kind === 'exit' ? action.trade.setup : action.setup
}

export function describeAction(action: MaAction) {
  if (action.kind === 'roll') return { title: '切换合约', detail: action.from + ' → ' + action.contract }
  if (action.kind === 'exit') {
    const { trade } = action
    return {
      title: exitLabels[trade.reason] + ' · 平' + side[trade.direction],
      detail: trade.contract + ' · ' + timingLabels[trade.exitTiming] + ' ' + trade.exitPrice + ' · 净 ' + signedMoney(trade.net),
    }
  }
  const { setup } = action
  const direction = side[setup.direction]
  switch (action.kind) {
    case 'signal':
      return {
        title: 'FVG 确认 · ' + direction,
        detail: setup.gapLow + '–' + setup.gapHigh + (action.skipped ? ' · 跳过信号（' + skipLabels[action.skipped] + '）' : ''),
      }
    case 'order':
      return { title: '限价挂' + direction, detail: setup.entry + ' · 止损 ' + setup.stop + ' · 止盈 ' + setup.target }
    case 'entry':
      return {
        title: '开' + direction + ' 1 手',
        detail: action.fill.price + ' · ' + (action.fill.atOpen ? '该根开盘成交' : '盘中回踩成交'),
      }
    case 'cancel':
      return { title: '撤销' + direction + '单', detail: cancelLabels[action.reason] }
    case 'entry_wait':
      return { title: '入场暂缓', detail: '一价 K 线 · 委托等待成交' }
    case 'exit_wait':
      return { title: exitLabels[action.reason] + '待执行', detail: '一价 K 线 · 等待下一根有价格区间的开盘' }
  }
}

export function maAnnotations(actions: MaAction[]): ChartAnnotation[] {
  const markers: ChartAnnotation[] = []
  for (const action of actions) {
    const { index } = action
    if (action.kind === 'roll') {
      markers.push({ index, color: '#aebbd3', position: 'aboveBar', shape: 'square', text: '换月', size: 0.65 })
    } else if (action.kind === 'exit') {
      const { trade } = action
      const color = trade.reason === 'target' ? '#a4d9a2' : trade.reason === 'stop' ? '#f1717e' : '#b8bfff'
      markers.push({
        index, color, position: trade.direction === 'long' ? 'aboveBar' : 'belowBar',
        shape: 'square', text: exitLabels[trade.reason], size: 0.6,
      })
      if (trade.reason !== 'roll') {
        markers.push({ index, color, position: 'atPriceMiddle', price: trade.exitPrice, shape: 'circle', size: 0.65 })
      }
    } else if (action.kind === 'entry') {
      const long = action.setup.direction === 'long'
      const color = long ? '#84dbff' : '#f1a4e0'
      markers.push({ index, color, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', text: long ? '开多' : '开空' })
      markers.push({ index, color, position: 'atPriceMiddle', price: action.fill.price, shape: 'circle', size: 0.65 })
    } else if (action.kind === 'signal' || action.kind === 'cancel') {
      markers.push({
        index, color: action.kind === 'cancel' ? '#aebbd3' : '#e5b962',
        position: action.setup.direction === 'long' ? 'belowBar' : 'aboveBar',
        shape: 'circle', text: action.kind === 'signal' ? 'FVG' : undefined, size: 0.6,
      })
    }
  }
  return markers
}

export function setupEvidence(setup: IctSetup): ChartAnnotation[] {
  const evidence: ChartAnnotation[] = [
    { index: setup.sweep.index, revealAt: setup.index, price: setup.sweep.liquidity.price,
      color: '#d1bae9', position: 'atPriceMiddle', shape: 'circle', size: 0.7, text: '扫荡' },
  ]
  if (setup.shiftIndex < setup.index) evidence.push({
    index: setup.shiftIndex, revealAt: setup.index, price: setup.sweep.structure.price,
    color: '#a8b9ff', position: 'atPriceMiddle', shape: 'circle', size: 0.7, text: 'MSS',
  })
  return evidence
}

function PositionStatus({ bars, frame, cursor }: { bars: MaBar[]; frame: MaFrame; cursor: number }) {
  const { pending, position } = frame
  const setup = pending ?? position?.setup
  const direction = setup ? side[setup.direction] : ''
  const title = position ? direction + '头 1 手' : pending ? direction + '单待回踩' : '空仓'

  return (
    <section className="panel ma-state" aria-label="当前状态">
      <div className="panel-heading">
        <h2>当前状态</h2>
        <span className={pending ? 'ma-state-badge pending' : 'ma-state-badge'}>{title}</span>
      </div>
      {setup && <>
        <dl className="ma-values">
          <div><dt>{position ? '开仓价' : '委托价'}</dt><dd>{position?.fill.price ?? setup.entry}</dd></div>
          <div><dt>止损</dt><dd className="negative">{setup.stop}</dd></div>
          <div><dt>止盈</dt><dd>{setup.target}</dd></div>
        </dl>
        <p className="ma-state-note">
          {position ? <>开仓 {position.entryBar.date} · 浮动 <b className={pnlTone(frame.equity - frame.realized)}>
            {signedMoney(frame.equity - frame.realized)}</b>{position.deferredExit && ' · ' + exitLabels[position.deferredExit] + '待执行'}</>
            : <>挂单 {bars[setup.index].date} · 已等待 {cursor - setup.index}/{ictRetestWindow} 根</>}
        </p>
      </>}
    </section>
  )
}

export function MaInspector({ bars, cursor, frame, loggedActions, evidence, seek }: {
  bars: MaBar[]; cursor: number; frame: MaFrame; loggedActions: MaAction[]; evidence?: IctSetup; seek: MaSeek
}) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [loggedActions])

  return (
    <aside className="ma-inspector" aria-label="甲醇回放明细">
      <PositionStatus bars={bars} frame={frame} cursor={cursor} />
      <section className="panel ma-log" aria-labelledby="ma-log-title">
        <div className="panel-heading">
          <h2 id="ma-log-title">操作记录</h2>
          <span className="muted">{loggedActions.length} 条</span>
        </div>
        {evidence && <div className="ma-evidence">
          <div><b>{side[evidence.direction]}头 FVG</b><span>{evidence.gapLow}–{evidence.gapHigh}</span></div>
          <div><span>扫荡 {evidence.sweep.liquidity.price}</span><time>{bars[evidence.sweep.index].date}</time></div>
          <div><span>结构转换 {evidence.sweep.structure.price}</span><time>{bars[evidence.shiftIndex].date}</time></div>
        </div>}
        {loggedActions.length ? (
          <ol className="ma-log-list" ref={list}>
            {loggedActions.map((action, index) => {
              const { title, detail } = describeAction(action)
              return (
                <li key={action.index + '-' + index}>
                  <button type="button" className="ma-log-entry" data-kind={action.kind}
                    aria-current={action.index === cursor ? 'step' : undefined}
                    onClick={() => seek(action.index, actionSetup(action))}>
                    <span><b>{title}</b><time>{bars[action.index].date}</time></span>
                    <small>{detail}</small>
                  </button>
                </li>
              )
            })}
          </ol>
        ) : <p className="ma-empty">推进回放或点击「下一动作」，查看首条操作。</p>}
      </section>
    </aside>
  )
}

export function MaTradeLedger({ trades, seek }: { trades: MaTrade[]; seek: MaSeek }) {
  return (
    <section className="panel history ma-ledger" aria-labelledby="ma-ledger-title">
      <div className="panel-heading">
        <h2 id="ma-ledger-title">已平仓交易</h2>
        <span className="muted">{trades.length} 笔 · 每笔 1 手</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th scope="col">合约 / 方向</th><th scope="col">信号</th><th scope="col">开仓</th><th scope="col">平仓</th>
            <th scope="col">退出原因</th><th scope="col">手续费</th><th scope="col">滑点成本</th><th scope="col">净盈亏</th>
          </tr></thead>
          <tbody>
            {trades.length === 0 && <tr><td colSpan={8} className="empty">当前进度暂无平仓。点击「查看期末」可查看全年逐笔记录。</td></tr>}
            {trades.map((trade) => (
              <tr key={trade.entryIndex}>
                <td>{trade.contract} · {side[trade.direction]}</td>
                <td><button className="ma-time-link" type="button" title="定位 FVG 确认"
                  onClick={() => seek(trade.setup.index, trade.setup)}>{trade.signal}</button></td>
                <td><button className="ma-time-link" type="button" title="定位开仓"
                  onClick={() => seek(trade.entryIndex, trade.setup)}>{trade.entry} · {trade.entryPrice}</button></td>
                <td><button className="ma-time-link" type="button" title="定位平仓"
                  onClick={() => seek(trade.exitIndex, trade.setup)}>{trade.exit} · {trade.exitPrice}</button></td>
                <td>{exitLabels[trade.reason]}</td>
                <td>{money(trade.fee)}</td>
                <td>{money(trade.slippage)}</td>
                <td className={pnlTone(trade.net)}>{signedMoney(trade.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

