import type { FailureReason, RowFailure } from '../domain/reasons.js'
import type { EmployeeDraft } from '../domain/validate.js'
import type { ImportStatus } from './models/import.js'

export interface CreateImportInput {
  filename: string
  total: number
  drafts: EmployeeDraft[]
  failures: RowFailure[]
}

export interface ClaimedRow {
  id: string
  importId: string
  line: number
  attempts: number
  payload: { name: string; email: string; startDate: string; country: string }
}

export interface ImportSummary {
  importId: string
  status: ImportStatus
  total: number
  counts: { pending: number; inFlight: number; succeeded: number; failed: number }
  failures: RowFailure[]
  failuresTruncated: boolean
  createdAt: Date
  completedAt: Date | null
}

/** A 5,000-row disaster must not return a 5,000-element blob to a polling client. */
export const MAX_INLINE_FAILURES = 100

export interface ImportRepository {
  createImport(input: CreateImportInput): Promise<string>
  getImport(id: string): Promise<ImportSummary | null>
  reapStaleClaims(staleBefore: Date): Promise<number>
  claimBatch(limit: number): Promise<ClaimedRow[]>
  markSucceeded(rowId: string): Promise<void>
  markFailed(rowId: string, reason: FailureReason, detail: string): Promise<void>
  releaseForRetry(rowId: string): Promise<void>
  settleFinishedImports(): Promise<void>
}
