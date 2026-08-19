import { describe, expect, it } from 'vitest'
import { CsvFormatError } from '../../src/csv/parse.js'
import { TooManyRowsError, processUpload } from '../../src/domain/upload.js'
import type { CreateImportInput, ImportRepository } from '../../src/store/importRepository.js'

class FakeRepo implements Partial<ImportRepository> {
  public last?: CreateImportInput
  async createImport(input: CreateImportInput): Promise<string> {
    this.last = input
    return 'imp_1'
  }
}

const HEADER = 'name,email,start_date,country'
const buf = (s: string) => Buffer.from(s, 'utf8')
const run = (csv: string, maxRows = 1000) => {
  const repo = new FakeRepo()
  return processUpload(buf(csv), 'a.csv', repo as ImportRepository, maxRows).then((r) => ({
    r,
    repo,
  }))
}

describe('processUpload', () => {
  it('accepts every valid row', async () => {
    const { r, repo } = await run(
      `${HEADER}\nAlice,a@x.com,01/03/2026,SG\nBob,b@x.com,02/03/2026,VN\n`,
    )
    expect(r).toMatchObject({ importId: 'imp_1', total: 2, accepted: 2, rejected: 0 })
    expect(r.failures).toEqual([])
    expect(repo.last!.drafts).toHaveLength(2)
    expect(repo.last!.filename).toBe('a.csv')
  })

  it('separates invalid rows and reports them with line numbers', async () => {
    const { r } = await run(`${HEADER}\nAlice,a@x.com,01/03/2026,SG\nBob,b@x.com,31/02/2026,VN\n`)
    expect(r).toMatchObject({ total: 2, accepted: 1, rejected: 1 })
    expect(r.failures[0]).toMatchObject({ line: 3, reason: 'INVALID_DATE' })
  })

  it('sorts all failures by line regardless of which check produced them', async () => {
    const { r } = await run(
      `${HEADER}\nA,a@x.com,01/03/2026,SG\nB,bad-email,01/03/2026,SG\nC,a@x.com,01/03/2026,SG\nD,d@x.com,31/02/2026,SG\n`,
    )
    expect(r.failures.map((f) => f.line)).toEqual([3, 4, 5])
    expect(r.failures.map((f) => f.reason)).toEqual([
      'INVALID_EMAIL',
      'DUPLICATE_IN_FILE',
      'INVALID_DATE',
    ])
  })

  it('propagates CsvFormatError for a bad header', async () => {
    await expect(run('wrong,header\n')).rejects.toThrow(CsvFormatError)
  })

  it('throws TooManyRowsError past the row cap without creating an import', async () => {
    const repo = new FakeRepo()
    const rows = Array.from({ length: 5 }, (_, i) => `P${i},p${i}@x.com,01/03/2026,SG`).join('\n')
    await expect(
      processUpload(buf(`${HEADER}\n${rows}\n`), 'a.csv', repo as ImportRepository, 3),
    ).rejects.toThrow(TooManyRowsError)
    expect(repo.last).toBeUndefined()
  })
})
