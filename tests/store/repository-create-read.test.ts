import { describe, expect, it } from 'vitest'
import type { RowFailure } from '../../src/domain/reasons.js'
import type { EmployeeDraft } from '../../src/domain/validate.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const repo = new MongooseImportRepository()

const draft = (line: number, email: string): EmployeeDraft => ({
  line,
  name: `Person ${line}`,
  email,
  emailNormalized: email.toLowerCase(),
  startDate: '2026-03-01',
  country: 'SG',
})

const failure = (line: number): RowFailure => ({
  line,
  email: null,
  reason: 'INVALID_DATE',
  detail: 'bad date',
})

describe('MongooseImportRepository create and read', () => {
  it('stores valid rows PENDING and invalid rows FAILED', async () => {
    const id = await repo.createImport({
      filename: 'a.csv',
      total: 3,
      drafts: [draft(2, 'a@x.com'), draft(3, 'b@x.com')],
      failures: [failure(4)],
    })
    expect(await ImportRowModel.countDocuments({ importId: id, status: 'PENDING' })).toBe(2)
    expect(await ImportRowModel.countDocuments({ importId: id, status: 'FAILED' })).toBe(1)
  })

  it('returns a summary with counts and failures', async () => {
    const id = await repo.createImport({
      filename: 'a.csv',
      total: 3,
      drafts: [draft(2, 'a@x.com'), draft(3, 'b@x.com')],
      failures: [failure(4)],
    })
    const s = await repo.getImport(id)
    expect(s).not.toBeNull()
    expect(s!.status).toBe('QUEUED')
    expect(s!.total).toBe(3)
    expect(s!.counts).toEqual({ pending: 2, inFlight: 0, succeeded: 0, failed: 1 })
    expect(s!.failures).toHaveLength(1)
    expect(s!.failures[0]!.line).toBe(4)
    expect(s!.failuresTruncated).toBe(false)
  })

  it('truncates the inline failure list at 100', async () => {
    const failures = Array.from({ length: 150 }, (_, i) => failure(i + 2))
    const id = await repo.createImport({ filename: 'a.csv', total: 150, drafts: [], failures })
    const s = await repo.getImport(id)
    expect(s!.failures).toHaveLength(100)
    expect(s!.failuresTruncated).toBe(true)
    expect(s!.counts.failed).toBe(150)
  })

  it('returns null for an unknown id', async () => {
    expect(await repo.getImport('66c1f0a3e4b0a1c2d3e4f5a6')).toBeNull()
  })

  it('returns null for a syntactically invalid id rather than throwing', async () => {
    expect(await repo.getImport('not-an-object-id')).toBeNull()
  })
})
