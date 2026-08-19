import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { buildServer } from '../../src/http/server.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const HEADER = 'name,email,start_date,country'
let app: FastifyInstance

beforeEach(async () => {
  app = await buildServer({
    repo: new MongooseImportRepository(),
    config: loadConfig({ MAX_ROWS: '10', MAX_FILE_BYTES: '2048' }),
  })
})
afterEach(async () => {
  await app.close()
})

function multipart(csv: string, filename = 'employees.csv') {
  const boundary = '----testboundary'
  const body = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
    'utf8',
  )
  return {
    payload: body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const post = (csv: string) => app.inject({ method: 'POST', url: '/imports', ...multipart(csv) })

describe('POST /imports', () => {
  it('returns 202 with a status url and inline failures', async () => {
    const res = await post(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,31/02/2026,SG\n`)
    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ total: 2, accepted: 1, rejected: 1 })
    expect(body.importId).toMatch(/^[a-f0-9]{24}$/)
    expect(body.statusUrl).toBe(`/imports/${body.importId}/status`)
    expect(body.failures[0]).toMatchObject({ line: 3, reason: 'INVALID_DATE' })
  })

  it('actually persists the accepted rows', async () => {
    const res = await post(`${HEADER}\nA,a@x.com,01/03/2026,SG\n`)
    const { importId } = res.json()
    expect(await ImportRowModel.countDocuments({ importId, status: 'PENDING' })).toBe(1)
  })

  it('returns 400 for a bad header', async () => {
    const res = await post('wrong,header\nA,B\n')
    expect(res.statusCode).toBe(400)
    expect(res.json().reason).toBe('INVALID_CSV')
  })

  it('returns 413 past the row cap', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => `P${i},p${i}@x.com,01/03/2026,SG`).join('\n')
    const res = await post(`${HEADER}\n${rows}\n`)
    expect(res.statusCode).toBe(413)
    expect(res.json().reason).toBe('TOO_LARGE')
  })
})

describe('GET /imports/:id/status', () => {
  it('reports counts for a fresh import', async () => {
    const { importId } = (
      await post(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,31/02/2026,SG\n`)
    ).json()
    const res = await app.inject({ method: 'GET', url: `/imports/${importId}/status` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      importId,
      status: 'QUEUED',
      total: 2,
      counts: { pending: 1, inFlight: 0, succeeded: 0, failed: 1 },
      failuresTruncated: false,
      completedAt: null,
    })
  })

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/imports/66c1f0a3e4b0a1c2d3e4f5a6/status' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
  })
})
