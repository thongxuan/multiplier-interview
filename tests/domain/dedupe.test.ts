import { describe, expect, it } from 'vitest'
import { dedupeByEmail } from '../../src/domain/dedupe.js'
import type { EmployeeDraft } from '../../src/domain/validate.js'

const draft = (line: number, email: string): EmployeeDraft => ({
  line,
  name: `Person ${line}`,
  email,
  emailNormalized: email.trim().toLowerCase(),
  startDate: '2026-03-01',
  country: 'SG',
})

describe('dedupeByEmail', () => {
  it('keeps everything when all emails are distinct', () => {
    const { kept, duplicates } = dedupeByEmail([draft(2, 'a@x.com'), draft(3, 'b@x.com')])
    expect(kept).toHaveLength(2)
    expect(duplicates).toHaveLength(0)
  })

  it('keeps the first occurrence and fails the second', () => {
    const { kept, duplicates } = dedupeByEmail([draft(2, 'a@x.com'), draft(7, 'a@x.com')])
    expect(kept.map((d) => d.line)).toEqual([2])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]!.line).toBe(7)
    expect(duplicates[0]!.reason).toBe('DUPLICATE_IN_FILE')
    expect(duplicates[0]!.detail).toContain('line 2')
  })

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const { kept, duplicates } = dedupeByEmail([draft(2, 'Alice@X.com'), draft(3, ' alice@x.com ')])
    expect(kept).toHaveLength(1)
    expect(duplicates[0]!.line).toBe(3)
  })
})
