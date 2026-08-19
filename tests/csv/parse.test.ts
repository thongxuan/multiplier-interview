import { describe, expect, it } from 'vitest'
import { CsvFormatError, parseCsv } from '../../src/csv/parse.js'

const HEADER = 'name,email,start_date,country'
const buf = (s: string) => Buffer.from(s, 'utf8')

describe('parseCsv', () => {
  it('parses a simple file and numbers lines from the spreadsheet perspective', () => {
    const rows = parseCsv(
      buf(`${HEADER}\nAlice,alice@x.com,01/03/2026,SG\nBob,bob@x.com,02/03/2026,VN\n`),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ line: 2, cells: ['Alice', 'alice@x.com', '01/03/2026', 'SG'] })
    expect(rows[1]!.line).toBe(3)
  })

  it('handles quoted commas inside a field', () => {
    const rows = parseCsv(buf(`${HEADER}\n"Tan, Alice",alice@x.com,01/03/2026,SG\n`))
    expect(rows[0]!.cells[0]).toBe('Tan, Alice')
  })

  it('strips a UTF-8 BOM from the header', () => {
    const rows = parseCsv(buf(`﻿${HEADER}\nAlice,alice@x.com,01/03/2026,SG\n`))
    expect(rows).toHaveLength(1)
  })

  it('returns short rows rather than throwing, so they can be reported per row', () => {
    const rows = parseCsv(buf(`${HEADER}\nAlice,alice@x.com\n`))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cells).toHaveLength(2)
    expect(rows[0]!.line).toBe(2)
  })

  it('rejects an empty file', () => {
    expect(() => parseCsv(buf(''))).toThrow(CsvFormatError)
  })

  it('rejects a wrong header', () => {
    expect(() => parseCsv(buf('name,email,start,country\nA,a@x.com,01/03/2026,SG\n'))).toThrow(
      /header/i,
    )
  })
})
