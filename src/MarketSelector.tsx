import { useEffect } from 'react'

/** Shared instrument navigation; replay engines retain their own saved sessions. */
export default function MarketSelector({ market }: { market: '159941' | 'MA' }) {
  useEffect(() => { document.title = `回放工作台 · ${market === 'MA' ? '甲醇' : '159941'}` }, [market])
  return <label className="market-selector">
    <span>交易标的</span>
    <select aria-label="交易标的" value={market} onChange={(event) => {
      location.hash = event.target.value === 'MA' ? 'ma-5m-manual' : 'etf'
    }}>
      <option value="159941">159941 · 纳指ETF广发</option>
      <option value="MA">MA · 甲醇</option>
    </select>
  </label>
}
