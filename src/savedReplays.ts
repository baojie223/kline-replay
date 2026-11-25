import { defaultSettings, resolveDate, startSession, validSettings } from './replay.ts'
import type { Bar, Session } from './replay.ts'

const runPrefix = 'etf-replay/159941/v2/run/'
const activeKey = 'etf-replay/159941/v2/active'
const legacyKey = 'etf-replay/159941/v1'

export type SavedReplay<T = Session> = {
  id: string
  createdAt: number
  updatedAt: number
  session: T
  saved: { revision?: string | null; session?: T }
}
export type ReplayLibrary<T = Session> = { activeId: string; runs: SavedReplay<T>[] }

export function newRun<T>(session: T, id: string = crypto.randomUUID()): SavedReplay<T> {
  const now = Date.now()
  return { id, createdAt: now, updatedAt: now, session, saved: {} }
}

function parseSession(raw: string | null, bars: Bar[]) {
  const saved = JSON.parse(raw ?? 'null')
  const session: Session | undefined = saved?.session
  if (!session || !validSettings(session.settings) || !Array.isArray(session.trades) ||
      !Number.isFinite(session.cash) || !Number.isFinite(session.shares)) return null
  const start = resolveDate(bars, saved.startDate)
  const cursor = resolveDate(bars, saved.cursorDate)
  if (start < 0 || cursor < start || bars[start]?.date !== saved.startDate || bars[cursor]?.date !== saved.cursorDate) return null
  const checkpoints = Array.isArray(session.checkpoints) && session.checkpoints.every((point, index, trail) =>
    point && point.cursor === cursor - trail.length + index && point.cursor >= start &&
    bars[point.cursor]?.date === point.barDate && Number.isInteger(point.tradeCount) &&
    point.tradeCount >= 0 && point.tradeCount <= session.trades.length) ? session.checkpoints : undefined
  return { saved, session: { ...session, start, cursor, checkpoints } }
}

export function readLibrary(bars: Bar[]): ReplayLibrary {
  const runs: SavedReplay[] = []
  let activeId: string | null = null
  try {
    const storage = window.localStorage
    activeId = storage.getItem(activeKey)
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(runPrefix)) continue
      try {
        const record = parseSession(storage.getItem(key), bars)
        if (!record || !Number.isFinite(record.saved.createdAt) || !Number.isFinite(record.saved.updatedAt)) continue
        runs.push({
          id: key.slice(runPrefix.length),
          createdAt: record.saved.createdAt,
          updatedAt: record.saved.updatedAt,
          session: record.session,
          saved: { revision: record.saved.revision ?? null, session: record.session },
        })
      } catch {
        // An unreadable record does not affect the rest of the library.
      }
    }
    if (!runs.length) {
      const legacy = parseSession(storage.getItem(legacyKey), bars)
      if (legacy) {
        const { session } = legacy
        const untouched = session.start === session.cursor && !session.trades.length && !session.pending &&
          !session.strategy && session.settings.commission === 0.03 && session.settings.minimum === 5
        runs.push(newRun(untouched ? startSession(session.start, { ...defaultSettings, capital: session.settings.capital })
          : session, 'legacy'))
      }
    }
  } catch {
    // The current tab can still run when storage is unavailable.
  }
  if (!runs.length) runs.push(newRun(startSession(Math.max(0, resolveDate(bars, '2025-04-03')), defaultSettings)))
  runs.sort((a, b) => b.updatedAt - a.updatedAt)
  return { activeId: runs.find((run) => run.id === activeId)?.id ?? runs[0].id, runs }
}

// The caller holds the library's write lock through the read, comparison and write.
export function writeReplay<T>(
  prefix: string, active: string, run: SavedReplay<T>, snapshot: (run: SavedReplay<T>) => object,
) {
  const storage = window.localStorage
  const { saved } = run
  if (saved.session === run.session) {
    storage.setItem(active, run.id)
    return
  }
  const raw = storage.getItem(prefix + run.id)
  const revision = raw === null ? undefined : JSON.parse(raw)?.revision ?? null
  const fork = revision !== saved.revision ? { ...run, id: crypto.randomUUID() } : undefined
  const destination = fork ?? run
  const nextRevision = crypto.randomUUID()
  storage.setItem(prefix + destination.id, JSON.stringify({ ...snapshot(destination), revision: nextRevision }))
  saved.revision = nextRevision
  saved.session = run.session
  storage.setItem(active, destination.id)
  return fork
}

export function saveRun(run: SavedReplay, bars: Bar[]) {
  return writeReplay(runPrefix, activeKey, run, ({ id, createdAt, updatedAt, session }) => ({
    id, createdAt, updatedAt, session,
    startDate: bars[session.start].date, cursorDate: bars[session.cursor].date,
  }))
}
