import { useEffect, useState } from 'react'
import type { DrawingPoint, ReplayDrawing } from './chartMarkup'

function validPoint(point: DrawingPoint | undefined) {
  return point && Number.isSafeInteger(point.time) && point.time > 0 && Number.isFinite(point.price) && point.price > 0
}

function parseDrawing(value: string | null, id: string): ReplayDrawing | undefined {
  try {
    const drawing = JSON.parse(value ?? 'null') as ReplayDrawing | null
    if (drawing?.id === id && (drawing.tool === 'box' || drawing.tool === 'line') &&
        /^#[0-9a-f]{6}$/i.test(drawing.color) && validPoint(drawing.first) && validPoint(drawing.last) &&
        Number.isSafeInteger(drawing.revealedAt) && drawing.revealedAt >= Math.max(drawing.first.time, drawing.last.time)) return drawing
  } catch {
    // An unreadable drawing does not prevent opening the other drawings.
  }
}

function updateDrawings(drawings: ReplayDrawing[], drawing: ReplayDrawing) {
  return drawings.some((item) => item.id === drawing.id)
    ? drawings.map((item) => item.id === drawing.id ? drawing : item) : [...drawings, drawing]
}

export function useReplayDrawings(scope: string) {
  const prefix = `etf-replay/ma/drawings/${scope}/`
  const [drawings, setDrawings] = useState<ReplayDrawing[]>(() => {
    const saved: ReplayDrawing[] = []
    try {
      const storage = window.localStorage
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (!key?.startsWith(prefix)) continue
        const drawing = parseDrawing(storage.getItem(key), key.slice(prefix.length))
        if (drawing) saved.push(drawing)
      }
    } catch {
      // Drawing is still available for the current tab.
    }
    return saved
  })
  const [storageError, setStorageError] = useState(false)

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (!event.key?.startsWith(prefix)) return
      const id = event.key.slice(prefix.length)
      const drawing = parseDrawing(event.newValue, id)
      setDrawings((current) => drawing ? updateDrawings(current, drawing) : current.filter((item) => item.id !== id))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [prefix])

  function save(drawing: ReplayDrawing) {
    try {
      window.localStorage.setItem(prefix + drawing.id, JSON.stringify(drawing))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
    setDrawings((current) => updateDrawings(current, drawing))
  }

  function remove(id: string) {
    try {
      window.localStorage.removeItem(prefix + id)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
    setDrawings((current) => current.filter((item) => item.id !== id))
  }

  return { drawings, save, remove, storageError }
}
