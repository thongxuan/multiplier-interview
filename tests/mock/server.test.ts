import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMockEmployeeService } from '../../src/mock/server.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildMockEmployeeService()
})
afterEach(async () => {
  await app.close()
})

const create = (payload: Record<string, unknown>, key?: string) =>
  app.inject({
    method: 'POST',
    url: '/employees',
    headers: key ? { 'idempotency-key': key } : {},
    payload,
  })

const alice = { name: 'Alice', email: 'alice@x.com', startDate: '2026-03-01', country: 'SG' }

describe('mock employee service', () => {
  it('creates an employee and returns 201 with an id', async () => {
    const res = await create(alice)
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBeDefined()
    expect(res.json().email).toBe('alice@x.com')
  })

  it('lists created employees and clears them on DELETE', async () => {
    await create(alice)
    expect((await app.inject({ method: 'GET', url: '/employees' })).json().employees).toHaveLength(1)
    await app.inject({ method: 'DELETE', url: '/employees' })
    expect((await app.inject({ method: 'GET', url: '/employees' })).json().employees).toHaveLength(0)
  })

  it('rejects a missing required field with 400', async () => {
    const { country, ...withoutCountry } = alice
    const res = await create(withoutCountry)
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('country')
  })

  it('accepts any country, in code or name form', async () => {
    expect((await create({ ...alice, country: 'France' })).statusCode).toBe(201)
    expect((await create({ ...alice, email: 'b@x.com', country: 'FR' })).statusCode).toBe(201)
  })

  it('rejects a "reject" email with 400', async () => {
    const res = await create({ ...alice, email: 'reject1@x.com' })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('reject')
  })

  it('returns the original employee for a repeated idempotency key without creating a second', async () => {
    const first = await create(alice, 'alice@x.com')
    const second = await create(alice, 'alice@x.com')

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.json().id).toBe(first.json().id)

    const list = await app.inject({ method: 'GET', url: '/employees' })
    expect(list.json().employees).toHaveLength(1)
  })

  it('fails a flaky email twice with 503 then succeeds', async () => {
    const payload = { ...alice, email: 'flaky1@x.com' }
    expect((await create(payload)).statusCode).toBe(503)
    expect((await create(payload)).statusCode).toBe(503)
    expect((await create(payload)).statusCode).toBe(201)
  })

  it('always fails a boom email with 503', async () => {
    const payload = { ...alice, email: 'boom1@x.com' }
    for (let i = 0; i < 5; i++) expect((await create(payload)).statusCode).toBe(503)
  })
})
