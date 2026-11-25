import { useCallback, useEffect, useState } from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { MaBar } from './maBacktest'

export function useMaPlayback(cursor: number, last: number, move: (direction: number) => void, suspended = false) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const running = playing && cursor < last && !suspended
  const pause = useCallback(() => setPlaying(false), [])
  const toggle = useCallback(() => setPlaying((active) => !active), [])
  const step = useCallback((direction: number) => {
    pause()
    move(direction)
  }, [move, pause])

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => move(1), 1000 / speed)
    return () => window.clearTimeout(timer)
  }, [cursor, move, running, speed])

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target
      if (suspended || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
          (target instanceof Element && target.closest('input, select, textarea, [contenteditable], [role=menu]'))) return
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault()
        step(event.code === 'ArrowLeft' ? -1 : 1)
      } else if (event.code === 'Space' && cursor < last &&
          !(target instanceof Element && target.closest('button, a'))) {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [cursor, last, step, toggle, suspended])

  return { running, pause, toggle, step, speed, setSpeed }
}

export default function MaPlayback({ playback, atStart, atEnd, bar, nextInChart = false }: {
  playback: ReturnType<typeof useMaPlayback>; atStart: boolean; atEnd: boolean; bar: Pick<MaBar, 'date' | 'contract'>
  nextInChart?: boolean
}) {
  const { running, toggle, step, speed, setSpeed } = playback
  return <div className="toolbar">
    <div className="playback">
      <button type="button" className="button primary play-button" disabled={atEnd} onClick={toggle} title="空格键播放或暂停">
        {running ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        {running ? '暂停' : '播放'}
      </button>
      <button type="button" className="button" disabled={atStart} onClick={() => step(-1)}
        title={nextInChart ? '左方向键回到上一个 5 分钟收盘' : '左方向键回退一根'}>
        <SkipBack size={15} />{nextInChart ? '回退' : '上一根'}
      </button>
      {!nextInChart && <button type="button" className="button" disabled={atEnd} onClick={() => step(1)} title="右方向键前进一根">
        <SkipForward size={15} />下一根
      </button>}
      <label className="speed">
        <span className="sr-only">播放速度</span>
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {[1, 4, 16, 32].map((value) => <option value={value} key={value}>{value}×</option>)}
        </select>
      </label>
    </div>
    <div className="cursor-label ma-cursor">
      <span className={running ? 'status-dot active' : 'status-dot'} />
      <b>{bar.date}</b>
      <span>{bar.contract}</span>
    </div>
  </div>
}
