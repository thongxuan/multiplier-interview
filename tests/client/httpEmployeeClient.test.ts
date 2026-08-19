import { describe, expect, it, vi } from 'vitest'
import type { EmployeePayload } from '../../src/client/employeeClient.js'
import { HttpEmployeeClient } from '../../src/client/httpEmployeeClient.js'

const payload: EmployeePayload = {
  name: 'Alice',
  email: 'Alice@X.com',
  startDate: '2026-03-01',
  country: 'SG',
}

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// baseDelayMs of 1 keeps retry tests fast without fake timers.
const client = (fetchImpl: typeof fetch) =>
  new HttpEmployeeClient({ baseUrl: 'http://svc', baseDelayMs: 1, fetchImpl })

describe('HttpEmployeeClient', () => {
  it('POSTs to /employees with the payload and an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => res(201, { id: 'e1' }))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)

    expect(r.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://svc/employees')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('alice@x.com')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('does not retry a 400 and reports UPSTREAM_REJECTED', async () => {
    const fetchImpl = vi.fn(async () => res(400, { message: "country 'XX' unsupported" }))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('UPSTREAM_REJECTED')
    expect(r.retryable).toBe(false)
    expect(r.detail).toContain('400')
    expect(r.detail).toContain('unsupported')
  })

  it('retries a 429 and succeeds on the second attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(201))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('retries a 503 then reports UPSTREAM_UNAVAILABLE as retryable', async () => {
    const fetchImpl = vi.fn(async () => res(503))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('UPSTREAM_UNAVAILABLE')
    expect(r.retryable).toBe(true)
  })

  it('retries a network error then reports UPSTREAM_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UPSTREAM_UNAVAILABLE')
  })
})
