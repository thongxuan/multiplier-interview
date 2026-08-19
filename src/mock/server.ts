import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'

/**
 * A stand-in for the real employee service, for end-to-end runs and manual testing.
 * Deliberately dependency-free relative to the rest of the application: it must be
 * possible to believe this is a different service written by a different team.
 *
 * Deterministic behaviours, driven by the email local part, so a Postman run can
 * demonstrate every failure path:
 *   "reject..." -> 400 always      (row lands UPSTREAM_REJECTED, never retried)
 *   "boom..."   -> 503 always      (row exhausts MAX_ATTEMPTS -> UPSTREAM_UNAVAILABLE)
 *   "flaky..."  -> 503 twice, then succeeds  (retry recovers it)
 *   "slow..."   -> succeeds after 2s         (exercises the concurrency pool)
 *   repeated Idempotency-Key -> 200 with the original employee, nothing created
 *
 * Country is deliberately NOT validated: this mock accepts whatever the customer's
 * spreadsheet says, in whatever form.
 */

const REQUIRED_FIELDS = ['name', 'email', 'startDate', 'country'] as const

interface Employee {
  id: string
  name: string
  email: string
  startDate: string
  country: string
  createdAt: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function buildMockEmployeeService(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const employees = new Map<string, Employee>() // id -> employee
  const byIdempotencyKey = new Map<string, string>() // key -> id
  const flakyCounts = new Map<string, number>()

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/employees', async () => ({ employees: [...employees.values()] }))

  app.delete('/employees', async (_req, reply) => {
    employees.clear()
    byIdempotencyKey.clear()
    flakyCounts.clear()
    return reply.code(204).send()
  })

  app.post<{ Body: Record<string, unknown> }>('/employees', async (request, reply) => {
    const body = request.body ?? {}

    for (const field of REQUIRED_FIELDS) {
      const value = body[field]
      if (typeof value !== 'string' || value.trim() === '') {
        return reply.code(400).send({ message: `${field} is required` })
      }
    }

    const employee = {
      name: String(body.name),
      email: String(body.email),
      startDate: String(body.startDate),
      country: String(body.country),
    }

    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey === 'string' && idempotencyKey !== '') {
      const existingId = byIdempotencyKey.get(idempotencyKey)
      if (existingId) {
        // A retry of a call that already succeeded. Return the original, create nothing.
        // Checked before the failure injections below, so a row that eventually
        // succeeded stays succeeded — exactly how a real idempotent endpoint behaves.
        return reply.code(200).send(employees.get(existingId))
      }
    }

    const localPart = employee.email.split('@')[0]?.toLowerCase() ?? ''

    if (localPart.startsWith('reject')) {
      return reply.code(400).send({ message: 'employee rejected (mock: reject)' })
    }

    if (localPart.startsWith('boom')) {
      return reply.code(503).send({ message: 'service unavailable (mock: boom)' })
    }

    if (localPart.startsWith('flaky')) {
      const seen = (flakyCounts.get(employee.email) ?? 0) + 1
      flakyCounts.set(employee.email, seen)
      if (seen <= 2) {
        return reply.code(503).send({ message: `service unavailable (mock: flaky ${seen}/2)` })
      }
    }

    if (localPart.startsWith('slow')) await sleep(2000)

    const created: Employee = {
      id: randomUUID(),
      ...employee,
      createdAt: new Date().toISOString(),
    }
    employees.set(created.id, created)
    if (typeof idempotencyKey === 'string' && idempotencyKey !== '') {
      byIdempotencyKey.set(idempotencyKey, created.id)
    }

    return reply.code(201).send(created)
  })

  await app.ready()
  return app
}

// Entrypoint for `npm run mock`.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? 8888)
  const app = await buildMockEmployeeService()
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[mock employee service] listening on http://localhost:${port}`)
}
