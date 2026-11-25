import { X } from 'lucide-react'

export type ReplayHistoryItem = {
  id: string
  createdAt: number
  updatedAt: number
  range: string
  summary: string
  detail: string
}

const timestamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

export default function ReplayHistory({ items, activeId, onClose, onOpen }: {
  items: ReplayHistoryItem[]; activeId: string; onClose: () => void; onOpen: (id: string) => void
}) {
  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <section className="dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="panel-heading">
          <h2 id="history-title">历史回放</h2>
          <button autoFocus type="button" aria-label="关闭" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="saved-runs">
          {items.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((item) => (
            <button type="button" className="saved-run" key={item.id} onClick={() => onOpen(item.id)} aria-current={item.id === activeId}>
              <span>
                <b>{item.range}</b>
                <small>建立于 {timestamp.format(item.createdAt)} · {item.summary}</small>
              </span>
              <span>
                <b>{item.id === activeId ? '当前回放' : '继续回放'}</b>
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
