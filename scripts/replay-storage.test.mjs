import assert from 'node:assert/strict'
import test from 'node:test'
import { newRun, writeReplay } from '../src/savedReplays.ts'

test('stale replay saves keep the original and update a separate copy', (context) => {
  const storage = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  }
  context.after(() => { delete globalThis.window })
  const prefix = 'run/'
  const original = newRun({ cursor: 0 })
  const save = (run) => writeReplay(prefix, 'active', run, ({ id, session }) => ({ id, session }))
  const key = prefix + original.id
  storage.set(key, JSON.stringify({ id: original.id, session: original.session }))
  const earlier = { ...original, saved: { revision: null, session: original.session } }
  const later = { ...original, saved: { revision: null, session: original.session } }

  assert.equal(save(later), undefined)
  assert.equal(save({ ...later, session: { cursor: 3 } }), undefined)
  const fork = save({ ...earlier, session: { cursor: 1 } })
  assert.notEqual(fork.id, original.id)
  assert.equal(save({ ...fork, session: { cursor: 2 } }), undefined)
  assert.equal(JSON.parse(storage.get(key)).session.cursor, 3)
  assert.equal(JSON.parse(storage.get(prefix + fork.id)).session.cursor, 2)
  assert.equal(storage.get('active'), fork.id)
})
