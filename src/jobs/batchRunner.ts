import type { EmployeeClient } from '../client/employeeClient.js'
import { mapWithConcurrency } from '../client/pool.js'
import type { ClaimedRow, ImportRepository } from '../store/importRepository.js'

export interface BatchRunnerDeps {
  repo: ImportRepository
  client: EmployeeClient
  batchSize: number
  concurrency: number
  maxAttempts: number
  staleClaimMs: number
  now?: () => Date
}

export interface BatchStats {
  claimed: number
  succeeded: number
  failed: number
  retried: number
  reaped: number
  skipped: boolean
}

type Outcome = 'succeeded' | 'failed' | 'retried'

/**
 * One tick: reap -> claim -> dispatch -> record -> settle.
 *
 * The overlap guard is instance state rather than a module-level flag, so each runner
 * (and each test) is independent. node-cron only calls runBatch on a timer; everything
 * worth testing lives here.
 */
export function createBatchRunner(deps: BatchRunnerDeps): { runBatch(): Promise<BatchStats> } {
  const now = deps.now ?? (() => new Date())
  let running = false

  async function dispatch(row: ClaimedRow): Promise<Outcome> {
    const result = await deps.client.createEmployee(row.payload)

    if (result.ok) {
      await deps.repo.markSucceeded(row.id)
      return 'succeeded'
    }

    const attemptsUsed = row.attempts + 1
    if (result.retryable && attemptsUsed < deps.maxAttempts) {
      await deps.repo.releaseForRetry(row.id)
      return 'retried'
    }

    await deps.repo.markFailed(row.id, result.reason, result.detail)
    return 'failed'
  }

  async function runBatch(): Promise<BatchStats> {
    // Without this, a slow batch gets a second worker dispatching the same rows and only
    // the idempotency key stands between us and duplicate employees.
    if (running) {
      return { claimed: 0, succeeded: 0, failed: 0, retried: 0, reaped: 0, skipped: true }
    }
    running = true
    try {
      const staleBefore = new Date(now().getTime() - deps.staleClaimMs)
      const reaped = await deps.repo.reapStaleClaims(staleBefore)

      const batch = await deps.repo.claimBatch(deps.batchSize)
      const outcomes = await mapWithConcurrency(batch, deps.concurrency, dispatch)

      await deps.repo.settleFinishedImports()

      return {
        claimed: batch.length,
        succeeded: outcomes.filter((o) => o === 'succeeded').length,
        failed: outcomes.filter((o) => o === 'failed').length,
        retried: outcomes.filter((o) => o === 'retried').length,
        reaped,
        skipped: false,
      }
    } finally {
      // A throwing tick that left running = true would wedge the cron forever.
      running = false
    }
  }

  return { runBatch }
}
