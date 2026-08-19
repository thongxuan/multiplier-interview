import { parse } from 'csv-parse/sync'

export const REQUIRED_HEADERS = ['name', 'email', 'start_date', 'country'] as const

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvFormatError'
  }
}

export interface RawRow {
  line: number
  cells: string[]
}

interface ParsedRecord {
  record: string[]
  info: { lines: number }
}

/**
 * Turns file bytes into rows, checking only the header. Row *content* is not judged here:
 * a row with the wrong number of cells is returned as-is so validation can report it
 * against its line number. Only file-level problems throw.
 */
export function parseCsv(buffer: Buffer): RawRow[] {
  let records: ParsedRecord[]
  try {
    records = parse(buffer, {
      bom: true,
      columns: false,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      info: true,
    }) as ParsedRecord[]
  } catch (err) {
    throw new CsvFormatError(`file is not valid CSV: ${(err as Error).message}`)
  }

  const first = records[0]
  if (!first) throw new CsvFormatError('file is empty')

  const header = first.record.map((h) => h.trim().toLowerCase())
  const expected = [...REQUIRED_HEADERS]
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    throw new CsvFormatError(
      `unexpected header: expected "${expected.join(',')}", got "${first.record.join(',')}"`,
    )
  }

  return records.slice(1).map((r) => ({ line: r.info.lines, cells: r.record }))
}
