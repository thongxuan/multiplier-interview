import { Types } from 'mongoose'
import type { FailureReason, RowFailure } from '../domain/reasons.js'
import type { EmployeeDraft } from '../domain/validate.js'
import {
  MAX_INLINE_FAILURES,
  type ClaimedRow,
  type CreateImportInput,
  type ImportRepository,
  type ImportSummary,
} from './importRepository.js'
import { ImportModel } from './models/import.js'
import { ImportRowModel } from './models/importRow.js'

const INSERT_CHUNK = 1000

function toObjectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null
}

export class MongooseImportRepository implements ImportRepository {
  async createImport(input: CreateImportInput): Promise<string> {
    const importId = new Types.ObjectId()

    const docs = [
      ...input.drafts.map((d: EmployeeDraft) => ({
        importId,
        line: d.line,
        status: 'PENDING' as const,
        payload: { name: d.name, email: d.email, startDate: d.startDate, country: d.country },
        emailNormalized: d.emailNormalized,
      })),
      ...input.failures.map((f: RowFailure) => ({
        importId,
        line: f.line,
        status: 'FAILED' as const,
        payload: { name: '', email: f.email ?? '', startDate: '', country: '' },
        // Per-line fallback so two MALFORMED_ROWs in one file cannot collide on ''.
        emailNormalized: f.email?.toLowerCase() ?? `__invalid_line_${f.line}`,
        reason: f.reason,
        detail: f.detail,
      })),
    ]

    // throwOnValidationError: without it, ordered:false collects validation errors into
    // the result and inserts nothing for those docs — a silent partial write.
    for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
      await ImportRowModel.insertMany(docs.slice(i, i + INSERT_CHUNK), {
        ordered: false,
        throwOnValidationError: true,
      })
    }

    // Written last: the cron must never see a half-inserted import.
    await ImportModel.create({
      _id: importId,
      filename: input.filename,
      total: input.total,
      status: 'QUEUED',
    })

    return importId.toHexString()
  }

  async getImport(id: string): Promise<ImportSummary | null> {
    const oid = toObjectId(id)
    if (!oid) return null

    const imp = await ImportModel.findById(oid).lean()
    if (!imp) return null

    const grouped = await ImportRowModel.aggregate<{ _id: string; n: number }>([
      { $match: { importId: oid } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    const by = (status: string) => grouped.find((g) => g._id === status)?.n ?? 0

    const failedDocs = await ImportRowModel.find({ importId: oid, status: 'FAILED' })
      .sort({ line: 1 })
      .limit(MAX_INLINE_FAILURES)
      .lean()

    const failedCount = by('FAILED')

    return {
      importId: id,
      status: imp.status,
      total: imp.total,
      counts: {
        pending: by('PENDING'),
        inFlight: by('IN_FLIGHT'),
        succeeded: by('SUCCEEDED'),
        failed: failedCount,
      },
      failures: failedDocs.map((d) => ({
        line: d.line,
        email: d.payload.email === '' ? null : d.payload.email,
        reason: d.reason as FailureReason,
        detail: d.detail ?? '',
      })),
      failuresTruncated: failedCount > MAX_INLINE_FAILURES,
      createdAt: imp.createdAt,
      completedAt: imp.completedAt ?? null,
    }
  }

  /**
   * Returns rows wedged IN_FLIGHT by a process that died mid-batch. Safe to re-dispatch
   * because every upstream call carries Idempotency-Key: <email>.
   */
  async reapStaleClaims(staleBefore: Date): Promise<number> {
    const res = await ImportRowModel.updateMany(
      { status: 'IN_FLIGHT', claimedAt: { $lt: staleBefore } },
      { $set: { status: 'PENDING', claimId: null, claimedAt: null }, $inc: { attempts: 1 } },
    )
    return res.modifiedCount
  }

  async claimBatch(limit: number): Promise<ClaimedRow[]> {
    const imp = await ImportModel.findOne({ status: { $in: ['QUEUED', 'PROCESSING'] } })
      .sort({ createdAt: 1 })
      .lean()
    if (!imp) return []

    const candidates = await ImportRowModel.find({ importId: imp._id, status: 'PENDING' })
      .select('_id')
      .limit(limit)
      .lean()
    if (candidates.length === 0) return []

    const claimId = new Types.ObjectId()
    await ImportRowModel.updateMany(
      // Repeating status: 'PENDING' is the guard. A competing worker that read the same
      // ids matches nothing, so each worker owns only the rows carrying its own claimId.
      { _id: { $in: candidates.map((c) => c._id) }, status: 'PENDING' },
      { $set: { status: 'IN_FLIGHT', claimId, claimedAt: new Date() } },
    )

    const claimed = await ImportRowModel.find({ claimId }).lean()
    if (claimed.length > 0 && imp.status === 'QUEUED') {
      await ImportModel.updateOne({ _id: imp._id }, { $set: { status: 'PROCESSING' } })
    }

    return claimed.map((r) => ({
      id: r._id.toHexString(),
      importId: r.importId.toHexString(),
      line: r.line,
      attempts: r.attempts,
      payload: {
        name: r.payload.name,
        email: r.payload.email,
        startDate: r.payload.startDate,
        country: r.payload.country,
      },
    }))
  }

  async markSucceeded(rowId: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'SUCCEEDED', claimId: null, claimedAt: null } },
    )
  }

  async markFailed(rowId: string, reason: FailureReason, detail: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'FAILED', reason, detail, claimId: null, claimedAt: null } },
    )
  }

  async releaseForRetry(rowId: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'PENDING', claimId: null, claimedAt: null }, $inc: { attempts: 1 } },
    )
  }

  async settleFinishedImports(): Promise<void> {
    const active = await ImportModel.find({ status: { $in: ['QUEUED', 'PROCESSING'] } }).lean()
    for (const imp of active) {
      const remaining = await ImportRowModel.countDocuments({
        importId: imp._id,
        status: { $in: ['PENDING', 'IN_FLIGHT'] },
      })
      if (remaining > 0) continue
      const failed = await ImportRowModel.countDocuments({ importId: imp._id, status: 'FAILED' })
      await ImportModel.updateOne(
        { _id: imp._id },
        {
          $set: {
            status: failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
            completedAt: new Date(),
          },
        },
      )
    }
  }
}
