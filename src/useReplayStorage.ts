import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ReplayLibrary, SavedReplay } from './savedReplays'

export function useReplayStorage<T>(
  lockName: string, run: SavedReplay<T>, setLibrary: Dispatch<SetStateAction<ReplayLibrary<T>>>,
  save: (run: SavedReplay<T>) => SavedReplay<T> | undefined, read: () => ReplayLibrary<T>,
) {
  const [storageError, setStorageError] = useState(false)
  const [forked, setForked] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    if (!navigator.locks) {
      setStorageError(true)
      return
    }
    void navigator.locks.request(lockName, { signal: controller.signal }, () => {
      const fork = save(run)
      if (fork) {
        const original = read().runs.find(({ id }) => id === run.id)
        setLibrary((current) => {
          const latest = current.runs.find(({ id }) => id === run.id)
          if (!latest) return current
          const runs = current.runs.filter(({ id }) => id !== run.id)
          if (original) runs.push(original)
          runs.push({ ...latest, id: fork.id })
          return { runs, activeId: current.activeId === run.id ? fork.id : current.activeId }
        })
        setForked(true)
      }
      setStorageError(false)
    }).catch(() => {
      if (!controller.signal.aborted) setStorageError(true)
    })
    return () => controller.abort()
  }, [lockName, read, run, save, setLibrary])

  return { storageError, forked }
}
