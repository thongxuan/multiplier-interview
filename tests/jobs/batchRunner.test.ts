import { describe, expect, it } from 'vitest'
import type {
  CreateResult,
  EmployeeClient,
  EmployeePayload,
} from '../../src/client/employeeClient.js'
import type { FailureReason } from '../../src/domain/reasons.js'
import { createBatchRunner } from '../../src/jobs/batchRunner.js'
import type { ClaimedRow, ImportRepository } from '../../src/store/importRepository.js'

interface Recorded {
  id: string
  kind: 'ok' | 'fail' | 'retry'
  reason?: FailureReason
}

class FakeRepo implements Partial<ImportRepository> {
  public rows: ClaimedRow[] = []
  public recorded: Recorded[] = []
  public reaped = 0
  public settled = 0
  public reapArgs: Date[] = []

  async reapStaleClaims(staleBefore: Date): Promise<number> {
    this.reapArgs.push(staleBefore)
    return this.reaped
  }
  async claimBatch(limit: number): Promise<ClaimedRow[]> {
    return this.rows.splice(0, limit)
  }
  async markSucceeded(id: string): Promise<void> {
    this.recorded.push({ id, kind: 'ok' })
  }
  async markFailed(id: string, reason: FailureReason): Promise<void> {
    this.recorded.push({ id, kind: 'fail', reason })
  }
  async releaseForRetry(id: string): Promise<void> {
    this.recorded.push({ id, kind: 'retry' })
  }
  async settleFinishedImports(): Promise<void> {
    this.settled += 1
  }
}

class FakeClient implements EmployeeClient {
  constructor(private readonly reply: (p: EmployeePayload) => CreateResult) {}
  public calls: EmployeePayload[] = []
  async createEmployee(p: EmployeePayload): Promise<CreateResult> {
    this.calls.push(p)
    return this.reply(p)
  }
}

const row = (id: string, attempts = 0): ClaimedRow => ({
  id,
  importId: 'imp_1',
  line: 2,
  attempts,
  payload: { name: 'A', email: `${id}@x.com`, startDate: '2026-03-01', country: 'SG' },
})

const runnerWith = (
  repo: FakeRepo,
  client: EmployeeClient,
  over: Partial<{ maxAttempts: number }> = {},
) =>
  createBatchRunner({
    repo: repo as unknown as ImportRepository,
    client,
    batchSize: 50,
    concurrency: 5,
    maxAttempts: over.maxAttempts ?? 3,
    staleClaimMs: 300_000,
  })

describe('runBatch', () => {
  it('marks a successful row SUCCEEDED', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    const stats = await runnerWith(repo, new FakeClient(() => ({ ok: true }))).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'ok' }])
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 })
  })

  it('marks a non-retryable rejection FAILED and never retries it', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    const client = new FakeClient(() => ({
      ok: false,
      retryable: false,
      reason: 'UPSTREAM_REJECTED',
      detail: 'bad country',
    }))
    await runnerWith(repo, client).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'fail', reason: 'UPSTREAM_REJECTED' }])
    expect(client.calls).toHaveLength(1)
  })

  it('releases a retryable failure for a later tick when attempts remain', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1', 0)]
    const client = new FakeClient(() => ({
      ok: false,
      retryable: true,
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: '503',
    }))
    const stats = await runnerWith(repo, client).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'retry' }])
    expect(stats.retried).toBe(1)
  })

  it('terminates a retryable failure once attempts are exhausted', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1', 2)] // this attempt is the third
    const client = new FakeClient(() => ({
      ok: false,
      retryable: true,
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: '503',
    }))
    const stats = await runnerWith(repo, client, { maxAttempts: 3 }).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'fail', reason: 'UPSTREAM_UNAVAILABLE' }])
    expect(stats.failed).toBe(1)
    expect(stats.retried).toBe(0)
  })

  it('handles a mixed batch, reaps first and settles at the end', async () => {
    const repo = new FakeRepo()
    repo.reaped = 4
    repo.rows = [row('ok1'), row('bad1'), row('flaky1')]
    const client = new FakeClient((p) => {
      if (p.email.startsWith('bad')) {
        return { ok: false, retryable: false, reason: 'UPSTREAM_REJECTED', detail: 'no' }
      }
      if (p.email.startsWith('flaky')) {
        return { ok: false, retryable: true, reason: 'UPSTREAM_UNAVAILABLE', detail: '503' }
      }
      return { ok: true }
    })
    const stats = await runnerWith(repo, client).runBatch()
    expect(stats).toMatchObject({ claimed: 3, succeeded: 1, failed: 1, retried: 1, reaped: 4 })
    expect(repo.reapArgs).toHaveLength(1)
    expect(repo.settled).toBe(1)
  })

  it('skips a re-entrant call while a tick is still in flight', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const client: EmployeeClient = {
      createEmployee: async () => {
        await gate
        return { ok: true }
      },
    }
    const runner = runnerWith(repo, client)

    const first = runner.runBatch()
    const second = await runner.runBatch()
    expect(second.skipped).toBe(true)
    expect(second.claimed).toBe(0)

    release()
    expect((await first).claimed).toBe(1)
  })
})
