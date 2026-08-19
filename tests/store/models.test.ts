import type { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { ImportModel } from '../../src/store/models/import.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const rowFor = (importId: Types.ObjectId, over: Record<string, unknown> = {}) => ({
  importId,
  line: 2,
  payload: { name: 'Alice', email: 'a@x.com', startDate: '2026-03-01', country: 'SG' },
  emailNormalized: 'a@x.com',
  ...over,
})

describe('models', () => {
  it('defaults a new import to QUEUED', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 3 })
    expect(imp.status).toBe('QUEUED')
    expect(imp.completedAt).toBeNull()
  })

  it('defaults a new row to PENDING with zero attempts', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 1 })
    const row = await ImportRowModel.create(rowFor(imp._id))
    expect(row.status).toBe('PENDING')
    expect(row.attempts).toBe(0)
    expect(row.claimId).toBeNull()
  })

  it('rejects a duplicate email within one import', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 2 })
    await ImportRowModel.create(rowFor(imp._id))
    await expect(ImportRowModel.create(rowFor(imp._id, { line: 3 }))).rejects.toThrow(
      /duplicate key/i,
    )
  })

  it('allows a duplicate email when the new row is already FAILED', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 2 })
    await ImportRowModel.create(rowFor(imp._id))
    await expect(
      ImportRowModel.create(
        rowFor(imp._id, {
          line: 3,
          status: 'FAILED',
          reason: 'DUPLICATE_IN_FILE',
          detail: 'dupe',
        }),
      ),
    ).resolves.toBeDefined()
  })
})
