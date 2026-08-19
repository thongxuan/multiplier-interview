import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/client/pool.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([5, 1, 3], 2, async (n) => {
      await sleep(n)
      return n * 2
    })
    expect(out).toEqual([10, 2, 6])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      5,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await sleep(5)
        inFlight -= 1
      },
    )
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([])
  })
})
