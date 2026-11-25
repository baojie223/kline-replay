import assert from 'node:assert/strict'
import test from 'node:test'
import { ema20 } from '../src/ema.ts'

test('EMA20 uses only earlier closes and starts again after a contract roll', () => {
  const first = Array.from({ length: 21 }, (_, index) => ({ close: index + 1, contract: 'MA601' }))
  const next = Array.from({ length: 20 }, () => ({ close: 50, contract: 'MA605' }))
  const values = ema20([...first, ...next])
  assert.deepEqual(values.slice(0, 21), ema20(first))
  assert.equal(values[18], undefined)
  assert.equal(values[19], 10.5)
  assert.equal(values[20], 11.5)
  assert.equal(values[21], undefined)
  assert.equal(values.at(-1), 50)
})
