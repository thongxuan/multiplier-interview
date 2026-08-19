import { parseCsv } from '../csv/parse.js'
import type { ImportRepository } from '../store/importRepository.js'
import { dedupeByEmail } from './dedupe.js'
import type { RowFailure } from './reasons.js'
import { validateRow, type EmployeeDraft } from './validate.js'

export class TooManyRowsError extends Error {
  constructor(rows: number, max: number) {
    super(`file has ${rows} rows, the maximum is ${max}`)
    this.name = 'TooManyRowsError'
  }
}

export interface UploadResult {
  importId: string
  total: number
  accepted: number
  rejected: number
  failures: RowFailure[]
}

/**
 * Parses, validates, dedupes and persists a whole file. Fast enough to run inside the
 * request: only the upstream dispatch is deferred to the batch runner.
 *
 * Throws CsvFormatError (-> 400) and TooManyRowsError (-> 413) for the route to map.
 */
export async function processUpload(
  buffer: Buffer,
  filename: string,
  repo: ImportRepository,
  maxRows: number,
): Promise<UploadResult> {
  const rows = parseCsv(buffer)
  if (rows.length > maxRows) throw new TooManyRowsError(rows.length, maxRows)

  const drafts: EmployeeDraft[] = []
  const failures: RowFailure[] = []

  for (const row of rows) {
    const result = validateRow(row)
    if (result.ok) drafts.push(result.draft)
    else failures.push(result.failure)
  }

  const { kept, duplicates } = dedupeByEmail(drafts)
  failures.push(...duplicates)
  failures.sort((a, b) => a.line - b.line)

  const importId = await repo.createImport({
    filename,
    total: rows.length,
    drafts: kept,
    failures,
  })

  return {
    importId,
    total: rows.length,
    accepted: kept.length,
    rejected: failures.length,
    failures,
  }
}
