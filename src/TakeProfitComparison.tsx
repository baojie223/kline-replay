import { Download, GitCompareArrows } from 'lucide-react'
import { targetRates, takeProfitResults } from './replay'
import type { Session } from './replay'

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.join(',')).join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })

export default function TakeProfitComparison({ results, settings, date }: {
  results: ReturnType<typeof takeProfitResults>; settings: Session['settings']; date: string
}) {
  function exportComparison() {
    const rows = results.flatMap(({ entry, stopPrice, alternatives }) => alternatives.map(({ rate, price, exit }) => [
      entry.reversal?.markDate ?? '', entry.reversal?.signalDate ?? '', entry.fillDate, entry.quantity,
      entry.price.toFixed(3), entry.fee.toFixed(2), `${settings.commission}%`, settings.minimum.toFixed(2),
      `${rate}%`, price.toFixed(3), exit ? exit.kind === 'stop' ? '已止损' : '已止盈' : '未触发',
      exit?.date ?? '', exit?.price.toFixed(3) ?? '', exit?.profit.toFixed(2) ?? '',
      exit ? `${(exit.netReturn * 100).toFixed(2)}%` : '', exit?.days ?? '', date,
      entry.stopLossRate === undefined ? '' : `${entry.stopLossRate}%`, stopPrice?.toFixed(3) ?? '',
    ]))
    downloadCsv('159941-逐笔止盈对比.csv', [
      ['逆转标记日', '第二根阳线日', '买入日', '份额', '买入价', '买入佣金', '单边佣金率', '最低佣金',
        '目标净收益率', '止盈限价', '状态', '卖出日', '卖出价', '净利润', '实际净收益率', '持有交易日', '回放截至',
        '止损目标', '止损触发价'],
      ...rows,
    ])
  }

  return (
    <section className="panel history comparison">
      <div className="panel-heading">
        <h2><GitCompareArrows size={17} /> 逐笔止盈对比 <span className="pill">{results.length} 笔</span></h2>
        <button className="button small" disabled={!results.length} onClick={exportComparison}><Download size={15} /> 导出止盈对比</button>
      </div>
      <p className="comparison-note">每笔策略买入独立跟踪九档净收益目标。各档共用买入价、份额和该笔设定的止损，按已回放行情更新。</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>策略买入</th>{targetRates.map((rate) => <th scope="col" key={rate}>{rate}%</th>)}</tr></thead>
          <tbody>
            {!results.length && <tr><td colSpan={10} className="empty">策略买入成交后开始跟踪</td></tr>}
            {results.slice().reverse().map(({ entry, stopPrice, alternatives }) => (
              <tr key={entry.fillDate}>
                <td><b>{entry.fillDate}</b><small>¥{entry.price.toFixed(3)} · {entry.quantity.toLocaleString('zh-CN')} 份</small>
                  {stopPrice !== undefined && <small>止损 ¥{stopPrice.toFixed(3)}</small>}</td>
                {alternatives.map(({ rate, price, exit }) => (
                  <td key={rate} title={exit ? `成交 ¥${exit.price.toFixed(3)} · 持有 ${exit.days} 个交易日` : undefined}>
                    {exit
                      ? <><b className={exit.profit < 0 ? 'negative' : 'positive'}>{money.format(exit.profit)}</b>
                        <small>{exit.kind === 'stop' ? '止损 · ' : ''}{exit.date}</small></>
                      : <>未触发<small>限价 ¥{price.toFixed(3)}</small></>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
