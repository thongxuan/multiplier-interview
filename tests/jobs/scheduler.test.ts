import cron from 'node-cron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from '../../src/jobs/scheduler.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startScheduler', () => {
  it('rejects an invalid cron expression', () => {
    expect(() => startScheduler('not a cron', async () => {})).toThrow(/cron/i)
  })

  it('registers the schedule and invokes the task when the callback fires', async () => {
    let fire: () => void = () => {}
    const stub = { stop: vi.fn() } as unknown as cron.ScheduledTask
    const schedule = vi.spyOn(cron, 'schedule').mockImplementation((_expr, cb) => {
      fire = cb as () => void
      return stub
    })

    const task = vi.fn(async () => {})
    startScheduler('*/10 * * * * *', task)

    expect(schedule.mock.calls[0]![0]).toBe('*/10 * * * * *')
    fire()
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  })
})
