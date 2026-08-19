import { describe, expect, it } from 'vitest'
import type { EmployeeDraft } from '../../src/domain/validate.js'
import { ImportModel } from '../../src/store/models/import.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const repo = new MongooseImportRepository()

const draft = (line: number): EmployeeDraft => ({
  line,
  name: `Person ${line}`,
  email: `p${line}@x.com`,
  emailNormalized: `p${line}@x.com`,
  startDate: '2026-03-01',
  country: 'SG',
})

async function seed(count: number, filename = 'a.csv'): Promise<string> {
  const drafts = Array.from({ length: count }, (_, i) => draft(i + 2))
  return repo.createImport({ filename, total: count, drafts, failures: [] })
}

describe('claimBatch', () => {
  it('returns an empty array when there is nothing pending', async () => {
    expect(await repo.claimBatch(10)).toEqual([])
  })

  it('claims no more than the limit', async () => {
    await seed(10)
    const batch = await repo.claimBatch(4)
    expect(batch).toHaveLength(4)
    expect(await ImportRowModel.countDocuments({ status: 'IN_FLIGHT' })).toBe(4)
    expect(await ImportRowModel.countDocuments({ status: 'PENDING' })).toBe(6)
  })

  it('returns the payload, line and attempts of each claimed row, and flips the import to PROCESSING', async () => {
    const id = await seed(1)
    const [row] = await repo.claimBatch(10)
    expect(row!.line).toBe(2)
    expect(row!.attempts).toBe(0)
    expect(row!.payload).toEqual({
      name: 'Person 2',
      email: 'p2@x.com',
      startDate: '2026-03-01',
      country: 'SG',
    })
    expect((await ImportModel.findById(id).lean())!.status).toBe('PROCESSING')
  })

  it('never hands the same row to two concurrent claimers', async () => {
    await seed(10)
    const [a, b] = await Promise.all([repo.claimBatch(10), repo.claimBatch(10)])
    const ids = [...a!.map((r) => r.id), ...b!.map((r) => r.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(10)
  })
})

describe('recording outcomes', () => {
  it('markSucceeded moves a row to SUCCEEDED and clears the claim', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.markSucceeded(row!.id)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('SUCCEEDED')
    expect(doc!.claimId).toBeNull()
  })

  it('markFailed records the reason and detail', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.markFailed(row!.id, 'UPSTREAM_REJECTED', 'employee-service 400: bad country')
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('FAILED')
    expect(doc!.reason).toBe('UPSTREAM_REJECTED')
    expect(doc!.detail).toContain('bad country')
  })

  it('releaseForRetry returns the row to PENDING and increments attempts', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.releaseForRetry(row!.id)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('PENDING')
    expect(doc!.attempts).toBe(1)
    expect(doc!.claimId).toBeNull()
  })
})

describe('reapStaleClaims', () => {
  it('returns a stale IN_FLIGHT row to PENDING and increments attempts', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await ImportRowModel.updateOne(
      { _id: row!.id },
      { $set: { claimedAt: new Date(Date.now() - 600_000) } },
    )

    const reaped = await repo.reapStaleClaims(new Date(Date.now() - 300_000))
    expect(reaped).toBe(1)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('PENDING')
    expect(doc!.attempts).toBe(1)
    expect(doc!.claimId).toBeNull()
  })

  it('leaves a fresh claim alone', async () => {
    await seed(1)
    await repo.claimBatch(1)
    expect(await repo.reapStaleClaims(new Date(Date.now() - 300_000))).toBe(0)
    expect(await ImportRowModel.countDocuments({ status: 'IN_FLIGHT' })).toBe(1)
  })
})

describe('settleFinishedImports', () => {
  it('marks an all-succeeded import COMPLETED with a completedAt', async () => {
    const id = await seed(2)
    for (const row of await repo.claimBatch(2)) await repo.markSucceeded(row.id)
    await repo.settleFinishedImports()
    const imp = await ImportModel.findById(id).lean()
    expect(imp!.status).toBe('COMPLETED')
    expect(imp!.completedAt).toBeInstanceOf(Date)
  })

  it('marks a partially failed import COMPLETED_WITH_ERRORS', async () => {
    const id = await seed(2)
    const batch = await repo.claimBatch(2)
    await repo.markSucceeded(batch[0]!.id)
    await repo.markFailed(batch[1]!.id, 'UPSTREAM_REJECTED', 'nope')
    await repo.settleFinishedImports()
    expect((await ImportModel.findById(id).lean())!.status).toBe('COMPLETED_WITH_ERRORS')
  })

  it('leaves an import alone while rows are still pending', async () => {
    const id = await seed(3)
    const batch = await repo.claimBatch(1)
    await repo.markSucceeded(batch[0]!.id)
    await repo.settleFinishedImports()
    expect((await ImportModel.findById(id).lean())!.status).toBe('PROCESSING')
  })
})
