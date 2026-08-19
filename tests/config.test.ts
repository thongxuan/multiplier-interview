import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('falls back to defaults when env is empty', () => {
    const c = loadConfig({})
    expect(c.port).toBe(3000)
    expect(c.mongoUri).toBe('mongodb://localhost:27017')
    expect(c.mongoDb).toBe('bulk_import')
    expect(c.employeeServiceUrl).toBe('http://localhost:4000')
    expect(c.cronSchedule).toBe('*/10 * * * * *')
    expect(c.batchSize).toBe(50)
    expect(c.upstreamConcurrency).toBe(5)
    expect(c.maxAttempts).toBe(3)
    expect(c.staleClaimMs).toBe(300_000)
    expect(c.maxRows).toBe(50_000)
    expect(c.maxFileBytes).toBe(52_428_800)
  })

  it('reads numbers from env', () => {
    const c = loadConfig({ PORT: '8080', BATCH_SIZE: '200' })
    expect(c.port).toBe(8080)
    expect(c.batchSize).toBe(200)
  })
})
