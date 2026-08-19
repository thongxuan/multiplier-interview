import type { FailureReason } from '../domain/reasons.js'

export interface EmployeePayload {
  name: string
  email: string
  startDate: string
  country: string
}

/**
 * `retryable: true` means the batch runner should return the row to PENDING for a later
 * tick. The client has already exhausted its own in-tick retries by then: those cover
 * transient blips, the cross-tick attempts cover longer outages.
 */
export type CreateResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: FailureReason; detail: string }

export interface EmployeeClient {
  createEmployee(payload: EmployeePayload): Promise<CreateResult>
}
