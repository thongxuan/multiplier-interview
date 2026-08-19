import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpEmployeeClient } from '../src/client/httpEmployeeClient.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/http/server.js'
import { createBatchRunner } from '../src/jobs/batchRunner.js'
import { buildMockEmployeeService } from '../src/mock/server.js'
import { MongooseImportRepository } from '../src/store/mongooseRepository.js'
import { useMongo } from './helpers/mongo.js'

useMongo()

const HEADER = 'name,email,start_date,country'
let api: FastifyInstance
let mock: FastifyInstance
let mockUrl: string

beforeEach(async () => {
  mock = await buildMockEmployeeService()
  await mock.listen({ port: 0, host: '127.0.0.1' })
  const address = mock.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  mockUrl = `http://127.0.0.1:${address.port}`

  api = await buildServer({ repo: new MongooseImportRepository(), config: loadConfig({}) })
})

afterEach(async () => {
  await api.close()
  await mock.close()
})

function upload(csv: string) {
  const boundary = '----smoke'
  return api.inject({
    method: 'POST',
    url: '/imports',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="e.csv"\r\n` +
        `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
      'utf8',
    ),
  })
}

const runner = () =>
  createBatchRunner({
    repo: new MongooseImportRepository(),
    client: new HttpEmployeeClient({ baseUrl: mockUrl, baseDelayMs: 1 }),
    batchSize: 50,
    concurrency: 5,
    maxAttempts: 3,
    staleClaimMs: 300_000,
  })

describe('end to end, in process', () => {
  it('uploads, dispatches on a tick, and reports COMPLETED', async () => {
    const { importId } = (
      await upload(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,02/03/2026,VN\n`)
    ).json()

    await runner().runBatch()

    const body = (await api.inject({ method: 'GET', url: `/imports/${importId}/status` })).json()
    expect(body.status).toBe('COMPLETED')
    expect(body.counts).toEqual({ pending: 0, inFlight: 0, succeeded: 2, failed: 0 })

    const created = (await mock.inject({ method: 'GET', url: '/employees' })).json()
    expect(created.employees).toHaveLength(2)
    expect(created.employees[0].startDate).toBe('2026-03-01')
  })

  it('reports COMPLETED_WITH_ERRORS when the upstream rejects a row', async () => {
    const { importId } = (
      await upload(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,02/03/2026,ZZ\n`)
    ).json()

    await runner().runBatch()

    const body = (await api.inject({ method: 'GET', url: `/imports/${importId}/status` })).json()
    expect(body.status).toBe('COMPLETED_WITH_ERRORS')
    expect(body.counts.succeeded).toBe(1)
    expect(body.counts.failed).toBe(1)
    expect(body.failures[0]).toMatchObject({ line: 3, reason: 'UPSTREAM_REJECTED' })
    expect(body.failures[0].detail).toContain('ZZ')
  })

  it('exhausts attempts on a permanently failing row', async () => {
    const { importId } = (await upload(`${HEADER}\nB,boom1@x.com,01/03/2026,VN\n`)).json()

    // maxAttempts is 3, so three ticks are needed to exhaust it.
    await runner().runBatch()
    await runner().runBatch()
    await runner().runBatch()

    const body = (await api.inject({ method: 'GET', url: `/imports/${importId}/status` })).json()
    expect(body.status).toBe('COMPLETED_WITH_ERRORS')
    expect(body.failures[0]!.reason).toBe('UPSTREAM_UNAVAILABLE')
  })
})
