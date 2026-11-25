import { Flag, SkipForward } from 'lucide-react'
import { defaultStopLossRate } from './replay'
import type { Session, StrategyRules } from './replay'

export const defaultRules: StrategyRules = { quantity: 1000, entry: 'close', target: 'net', stopLossRate: defaultStopLossRate }

export default function StrategyPanel({ session, date, lastBar, rules, quantity, onQuantity, onRules, onMark, onCancel, onFastForward }: {
  session: Session
  date: string
  lastBar: boolean
  rules: StrategyRules
  quantity: string
  onQuantity: (value: string) => void
  onRules: (rules: StrategyRules) => void
  onMark: () => void
  onCancel: () => void
  onFastForward: () => void
}) {
  const active = session.strategy
  const holding = active?.phase === 'holding' ? active : undefined
  const phase = !active ? '等待标记' : active.phase === 'counting' ? '等待阳线'
    : active.phase === 'entry' ? '等待开盘' : active.stopTriggered ? '止损待成交'
      : active.stopPrice === undefined ? '止盈单已挂' : '止盈止损已挂'
  const bullish = !active ? 0 : active.phase === 'counting' ? active.bullish : 2
  const blocked = session.pending ? '请先撤销手动委托。' : session.shares ? '请先平掉手动持仓。' : ''

  return (
    <div className="strategy">
      <div className="panel-heading">
        <h2>逆转回测</h2><span className={holding ? 'pill target-pill' : 'pill'}>{phase}</span>
      </div>
      <div className="strategy-progress" aria-label={`已出现 ${bullish} 根阳线`}>
        <span><Flag size={14} /> {active?.markDate ?? date}</span>
        <div><i className={bullish >= 1 ? 'filled' : ''} /><i className={bullish >= 2 ? 'filled' : ''} /></div>
        <b>{bullish} / 2 阳线</b>
      </div>
      {active ? (
        <>
          {holding ? (
            <dl className="strategy-position">
              <div><dt>买入价</dt><dd>¥{holding.entryPrice.toFixed(3)}</dd></div>
              <div><dt>止盈限价</dt><dd className="positive">¥{holding.targetPrice.toFixed(3)}</dd></div>
              <div><dt>入场日期</dt><dd>{holding.entryDate}</dd></div>
              <div><dt>持仓</dt><dd>{holding.quantity.toLocaleString('zh-CN')} 份</dd></div>
              {holding.stopPrice !== undefined && <div><dt>止损触发价</dt><dd className="negative">¥{holding.stopPrice.toFixed(3)}</dd></div>}
            </dl>
          ) : <p className="strategy-hint">
            {active.phase === 'entry' ? `${active.signalDate} 已确认第二根阳线，下一交易日开盘买入。`
              : '继续逐根回放，收盘价高于开盘价时累计一根阳线。'}
          </p>}
          <div className="strategy-actions">
            <button className="button" disabled={lastBar} onClick={onFastForward}><SkipForward size={15} /> 快进到下一动作</button>
            {!holding && <button className="text-button" onClick={onCancel}>取消信号</button>}
          </div>
          {lastBar && <p className="strategy-hint">{holding ? '行情结束 · 仓位仍未平仓' : '行情结束 · 信号尚未成交'}</p>}
        </>
      ) : (
        <>
          <p className="strategy-hint">看到逆转时标记当前 K 线。标记当天参与计数，第二根阳线触发买入。</p>
          <label className="quantity-label">每笔份额
            <div className="quantity-input">
              <input type="number" min="100" step="100" value={quantity} onChange={(event) => onQuantity(event.target.value)} />
              <span>份</span>
            </div>
          </label>
          <div className="strategy-fields">
            <div className="strategy-field">
              <label htmlFor="strategy-entry">入场</label>
              <select id="strategy-entry" value={rules.entry} onChange={(event) => onRules({ ...rules, entry: event.target.value as StrategyRules['entry'] })}>
                <option value="close">第二根阳线收盘</option>
                <option value="open">下一交易日开盘</option>
              </select>
            </div>
            <div className="strategy-field">
              <label htmlFor="strategy-target">止盈</label>
              <select id="strategy-target" value={rules.target} onChange={(event) => onRules({ ...rules, target: event.target.value as StrategyRules['target'] })}>
                <option value="net">净收益 +1%</option>
                <option value="price">成交价 +1%</option>
              </select>
            </div>
          </div>
          <div className="quantity-label">
            <label htmlFor="strategy-stop-loss">止损（净亏损）</label>
            <div className="quantity-input">
              <input id="strategy-stop-loss" type="number" min="1" max="10" step="0.1"
                value={Number.isNaN(rules.stopLossRate) ? '' : rules.stopLossRate ?? defaultStopLossRate}
                onChange={(event) => onRules({ ...rules, stopLossRate: event.target.valueAsNumber })} />
              <span>%</span>
            </div>
          </div>
          <button className="button primary mark-button" disabled={lastBar || !!blocked} onClick={onMark}><Flag size={15} /> 标记逆转</button>
          {blocked && <p className="strategy-hint">{blocked}</p>}
        </>
      )}
      {session.message && <p className="order-status" role="status">{session.message}</p>}
    </div>
  )
}
