import type { RawRow } from '../csv/parse.js'
import { FailureReason, type RowFailure } from './reasons.js'

export interface EmployeeDraft {
  line: number
  name: string
  email: string
  emailNormalized: string
  startDate: string
  country: string
}

export type ValidationResult =
  | { ok: true; draft: EmployeeDraft }
  | { ok: false; failure: RowFailure }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/

/** Converts a strict DD/MM/YYYY string to ISO YYYY-MM-DD, or null if it is not a real date. */
export function toIsoDate(value: string): string | null {
  const m = DATE_RE.exec(value)
  if (!m) return null
  const [, dd, mm, yyyy] = m as unknown as [string, string, string, string]
  const day = Number(dd)
  const month = Number(mm)
  const year = Number(yyyy)
  const d = new Date(Date.UTC(year, month - 1, day))
  // Round-trip check: Date rolls 31/02 forward to 03/03, so comparing the parts back
  // is what rejects days that do not exist.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null
  }
  return `${yyyy}-${mm}-${dd}`
}

function fail(
  line: number,
  email: string | null,
  reason: RowFailure['reason'],
  detail: string,
): ValidationResult {
  return { ok: false, failure: { line, email, reason, detail } }
}

export function validateRow(row: RawRow): ValidationResult {
  if (row.cells.length !== 4) {
    return fail(
      row.line,
      null,
      FailureReason.MALFORMED_ROW,
      `expected 4 columns, got ${row.cells.length}`,
    )
  }

  const [name, email, startDate, country] = row.cells.map((c) => c.trim()) as [
    string,
    string,
    string,
    string,
  ]
  const emailForReport = email === '' ? null : email

  const fields: Array<[string, string]> = [
    ['name', name],
    ['email', email],
    ['start_date', startDate],
    ['country', country],
  ]
  for (const [label, value] of fields) {
    if (value === '') {
      return fail(row.line, emailForReport, FailureReason.MISSING_FIELD, `${label} is required`)
    }
  }

  if (!EMAIL_RE.test(email)) {
    return fail(
      row.line,
      email,
      FailureReason.INVALID_EMAIL,
      `email '${email}' is not a valid address`,
    )
  }

  const iso = toIsoDate(startDate)
  if (iso === null) {
    return fail(
      row.line,
      email,
      FailureReason.INVALID_DATE,
      `start_date '${startDate}' is not a real DD/MM/YYYY date`,
    )
  }

  return {
    ok: true,
    draft: {
      line: row.line,
      name,
      email,
      emailNormalized: email.toLowerCase(),
      startDate: iso,
      country,
    },
  }
}
