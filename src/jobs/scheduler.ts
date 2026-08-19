import cron, { type ScheduledTask } from 'node-cron'

export type { ScheduledTask }

export function startScheduler(
  schedule: string,
  task: () => Promise<unknown>,
  onError: (err: Error) => void = (err) => console.error('[cron] tick failed:', err.message),
): ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`invalid cron expression: "${schedule}"`)
  }
  return cron.schedule(schedule, () => {
    // node-cron ignores the returned promise, so an unhandled rejection here would
    // otherwise take the process down.
    void task().catch((err: unknown) => onError(err as Error))
  })
}
