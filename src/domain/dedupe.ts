import { FailureReason, type RowFailure } from './reasons.js'
import type { EmployeeDraft } from './validate.js'

/** First occurrence of an email wins; every later one becomes a reportable failure. */
export function dedupeByEmail(drafts: EmployeeDraft[]): {
  kept: EmployeeDraft[]
  duplicates: RowFailure[]
} {
  const seen = new Map<string, number>()
  const kept: EmployeeDraft[] = []
  const duplicates: RowFailure[] = []

  for (const d of drafts) {
    const key = d.emailNormalized.trim().toLowerCase()
    const winner = seen.get(key)
    if (winner !== undefined) {
      duplicates.push({
        line: d.line,
        email: d.email,
        reason: FailureReason.DUPLICATE_IN_FILE,
        detail: `email '${key}' already appears on line ${winner}`,
      })
      continue
    }
    seen.set(key, d.line)
    kept.push(d)
  }

  return { kept, duplicates }
}
