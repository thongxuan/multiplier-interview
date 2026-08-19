export const FailureReason = {
  MALFORMED_ROW: 'MALFORMED_ROW',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_DATE: 'INVALID_DATE',
  DUPLICATE_IN_FILE: 'DUPLICATE_IN_FILE',
  UPSTREAM_REJECTED: 'UPSTREAM_REJECTED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
} as const

export type FailureReason = (typeof FailureReason)[keyof typeof FailureReason]

export const ALL_FAILURE_REASONS = Object.values(FailureReason)

export interface RowFailure {
  line: number
  email: string | null
  reason: FailureReason
  detail: string
}
