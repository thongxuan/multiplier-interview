import { describe, expect, it } from 'vitest'
import type { RawRow } from '../../src/csv/parse.js'
import { validateRow } from '../../src/domain/validate.js'

const row = (cells: string[], line = 2): RawRow => ({ line, cells })
const good = ['Alice Tan', 'Alice@X.com', '01/03/2026', 'SG']

describe('validateRow', () => {
  it('accepts a good row and normalizes email and date', () => {
    const r = validateRow(row(good))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft).toEqual({
      line: 2,
      name: 'Alice Tan',
      email: 'Alice@X.com',
      emailNormalized: 'alice@x.com',
      startDate: '2026-03-01',
      country: 'SG',
    })
  })

  it('reports MALFORMED_ROW when the column count is wrong', () => {
    const r = validateRow(row(['Alice', 'a@x.com']))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failure.reason).toBe('MALFORMED_ROW')
    expect(r.failure.line).toBe(2)
    expect(r.failure.email).toBeNull()
  })

  it('reports MISSING_FIELD when a field is blank', () => {
    const r = validateRow(row(['Alice', 'a@x.com', '01/03/2026', '  ']))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failure.reason).toBe('MISSING_FIELD')
    expect(r.failure.detail).toContain('country')
  })

  it('reports INVALID_EMAIL for a malformed address', () => {
    const r = validateRow(row(['Alice', 'not-an-email', '01/03/2026', 'SG']))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failure.reason).toBe('INVALID_EMAIL')
  })

  // The two cases that matter: a day that does not exist, and the wrong format entirely.
  it.each(['31/02/2026', '2026-01-01'])('reports INVALID_DATE for %s', (date) => {
    const r = validateRow(row(['Alice', 'a@x.com', date, 'SG']))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failure.reason).toBe('INVALID_DATE')
  })
})
