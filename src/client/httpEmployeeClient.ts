import { FailureReason } from '../domain/reasons.js'
import type { CreateResult, EmployeeClient, EmployeePayload } from './employeeClient.js'

export interface HttpEmployeeClientOptions {
  baseUrl: string
  attempts?: number
  baseDelayMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class HttpEmployeeClient implements EmployeeClient {
  private readonly baseUrl: string
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpEmployeeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.attempts = opts.attempts ?? 3
    this.baseDelayMs = opts.baseDelayMs ?? 200
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async createEmployee(payload: EmployeePayload): Promise<CreateResult> {
    let lastDetail = 'no attempt was made'

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/employees`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Email is the natural key, so a retry after a timeout cannot double-create.
            'Idempotency-Key': payload.email.trim().toLowerCase(),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        })

        if (response.ok) return { ok: true }

        const body = await response.text().catch(() => '')
        const detail = `employee-service ${response.status}: ${summarize(body)}`

        // 4xx other than 429 is a verdict, not a blip. Retrying it is pointless.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return { ok: false, retryable: false, reason: FailureReason.UPSTREAM_REJECTED, detail }
        }
        lastDetail = detail
      } catch (err) {
        lastDetail = `employee-service unreachable: ${(err as Error).message}`
      }

      if (attempt < this.attempts) {
        const backoff = this.baseDelayMs * 2 ** (attempt - 1)
        await sleep(backoff + Math.floor(Math.random() * this.baseDelayMs))
      }
    }

    return {
      ok: false,
      retryable: true,
      reason: FailureReason.UPSTREAM_UNAVAILABLE,
      detail: `${lastDetail} (after ${this.attempts} attempts)`,
    }
  }
}

function summarize(body: string): string {
  if (body === '') return '(empty body)'
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? body.slice(0, 200)
  } catch {
    return body.slice(0, 200)
  }
}
