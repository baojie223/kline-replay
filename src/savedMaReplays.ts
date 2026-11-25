import { maManualSnapshot, newMaManualSession, parseMaManualSnapshot } from './maManual'
import type { MaManualSession } from './maManual'
import type { MaBar } from './maBacktest'
import { newRun, writeReplay } from './savedReplays'
import type { ReplayLibrary, SavedReplay } from './savedReplays'

const runPrefix = 'etf-replay/ma/5m/manual/v2/run/'
const activeKey = 'etf-replay/ma/5m/manual/v2/active'
const legacyKey = 'etf-replay/ma/5m/manual/v1'

export function readMaLibrary(bars: MaBar[], earliest: number): ReplayLibrary<MaManualSession> {
  const runs: SavedReplay<MaManualSession>[] = []
  let activeId: string | null = null
  try {
    const storage = window.localStorage
    activeId = storage.getItem(activeKey)
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(runPrefix)) continue
      try {
        const saved = JSON.parse(storage.getItem(key) ?? 'null')
        const session = parseMaManualSnapshot(saved?.session, bars, earliest)
        if (session && Number.isFinite(saved.createdAt) && Number.isFinite(saved.updatedAt)) {
          runs.push({
            id: key.slice(runPrefix.length), createdAt: saved.createdAt, updatedAt: saved.updatedAt, session,
            saved: { revision: saved.revision ?? null, session },
          })
        }
      } catch {
        // Other runs can still be opened when one record is unreadable.
      }
    }
    if (!runs.some(({ id }) => id === 'legacy')) {
      const legacy = parseMaManualSnapshot(JSON.parse(storage.getItem(legacyKey) ?? 'null'), bars, earliest)
      if (legacy) runs.push(newRun(legacy, 'legacy'))
    }
  } catch {
    // Keep any valid runs if the browser cannot read the rest of storage.
  }
  if (!runs.length) runs.push(newRun(newMaManualSession(earliest)))
  runs.sort((a, b) => b.updatedAt - a.updatedAt)
  return { activeId: runs.find((run) => run.id === activeId)?.id ?? runs[0].id, runs }
}

export function saveMaRun(run: SavedReplay<MaManualSession>, bars: MaBar[]) {
  return writeReplay(runPrefix, activeKey, run, ({ id, createdAt, updatedAt, session }) => ({
    id, createdAt, updatedAt, session: maManualSnapshot(session, bars),
  }))
}
