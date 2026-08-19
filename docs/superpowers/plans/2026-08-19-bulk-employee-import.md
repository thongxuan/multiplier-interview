# Bulk Employee Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone service that accepts a CSV of employees, validates it, and creates every valid row in the existing employee service, reporting per-row failures.

**Architecture:** Upload and dispatch are decoupled. `POST /imports` parses, validates, dedupes and persists every row to MongoDB, then returns `202` immediately. A `node-cron` job claims batches of pending rows and dispatches them to `POST /employees` through a bounded concurrency pool with retry and an idempotency key. `GET /imports/:id/status` reports live counts and accumulated failures.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Mongoose, node-cron, csv-parse, Vitest, mongodb-memory-server.

**Spec:** `docs/superpowers/specs/2026-08-19-bulk-employee-import-design.md`

## Global Constraints

- TypeScript `strict: true`, module resolution `NodeNext`, target `ES2023`.
- All imports of local files use explicit `.js` extensions (NodeNext ESM requirement).
- Node 24's global `fetch` is used for HTTP. Do not add `axios`, `undici`, or `node-fetch`.
- No `any`. Use `unknown` plus narrowing where a type is genuinely open.
- Failure reason codes are exactly: `MALFORMED_ROW`, `MISSING_FIELD`, `INVALID_EMAIL`, `INVALID_DATE`, `DUPLICATE_IN_FILE`, `UPSTREAM_REJECTED`, `UPSTREAM_UNAVAILABLE`. No others.
- Import status values are exactly: `QUEUED`, `PROCESSING`, `COMPLETED`, `COMPLETED_WITH_ERRORS`.
- Row status values are exactly: `PENDING`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED`.
- `line` in every failure is the **spreadsheet line number**: header is line 1, first data row is line 2.
- CSV headers are exactly `name,email,start_date,country` in that order.
- Dates in CSV are `DD/MM/YYYY`; dates sent upstream are ISO `YYYY-MM-DD`.
- Every task ends with a commit. Tests must pass before committing.
- **Test scope is deliberately basic.** One test per behaviour that matters — happy path, the main failure per component, and the concurrency guarantees (atomic claim, overlap guard, pool ceiling) that are genuinely hard to get right. Edge-case tables the spec's test section lists (BOM, CRLF, leap years, every reason code, every missing field) are intentionally **not** implemented; the spec records them as the natural next increment.

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and the `Config` type, with fields `port: number`, `mongoUri: string`, `mongoDb: string`, `employeeServiceUrl: string`, `cronSchedule: string`, `batchSize: number`, `upstreamConcurrency: number`, `maxAttempts: number`, `staleClaimMs: number`, `maxRows: number`, `maxFileBytes: number`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "bulk-employee-import",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "mock": "tsx src/mock/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "gen:csv": "tsx scripts/generate-csv.ts"
  },
  "dependencies": {
    "@fastify/multipart": "^9.0.1",
    "csv-parse": "^5.6.0",
    "fastify": "^5.2.0",
    "mongoose": "^8.9.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "mongodb-memory-server": "^10.1.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

`mongodb-memory-server` downloads and boots a real `mongod`; the default 5s timeout is not enough on a cold first run.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.mongodb-binaries/
```

- [ ] **Step 5: Create `.env.example`**

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=bulk_import
EMPLOYEE_SERVICE_URL=http://localhost:4000
CRON_SCHEDULE=*/10 * * * * *
BATCH_SIZE=50
UPSTREAM_CONCURRENCY=5
MAX_ATTEMPTS=3
STALE_CLAIM_MS=300000
MAX_ROWS=50000
MAX_FILE_BYTES=52428800
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: completes, `node_modules/` created, no peer-dependency errors.

- [ ] **Step 7: Write the failing test**

Create `tests/config.test.ts`:

```ts
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
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 9: Write the implementation**

Create `src/config.ts`:

```ts
export interface Config {
  port: number
  mongoUri: string
  mongoDb: string
  employeeServiceUrl: string
  cronSchedule: string
  batchSize: number
  upstreamConcurrency: number
  maxAttempts: number
  staleClaimMs: number
  maxRows: number
  maxFileBytes: number
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`)
  }
  return parsed
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined || raw === '' ? fallback : raw
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: num(env, 'PORT', 3000),
    mongoUri: str(env, 'MONGODB_URI', 'mongodb://localhost:27017'),
    mongoDb: str(env, 'MONGODB_DB', 'bulk_import'),
    employeeServiceUrl: str(env, 'EMPLOYEE_SERVICE_URL', 'http://localhost:4000'),
    cronSchedule: str(env, 'CRON_SCHEDULE', '*/10 * * * * *'),
    batchSize: num(env, 'BATCH_SIZE', 50),
    upstreamConcurrency: num(env, 'UPSTREAM_CONCURRENCY', 5),
    maxAttempts: num(env, 'MAX_ATTEMPTS', 3),
    staleClaimMs: num(env, 'STALE_CLAIM_MS', 300_000),
    maxRows: num(env, 'MAX_ROWS', 50_000),
    maxFileBytes: num(env, 'MAX_FILE_BYTES', 52_428_800),
  }
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts tests/config.test.ts
git commit -m "chore: scaffold project with typed config loader"
```

---

### Task 2: CSV parsing

**Files:**
- Create: `src/domain/reasons.ts`, `src/csv/parse.ts`
- Test: `tests/csv/parse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/domain/reasons.ts`: the `FailureReason` const object and type, and `interface RowFailure { line: number; email: string | null; reason: FailureReason; detail: string }`.
  - `src/csv/parse.ts`: `REQUIRED_HEADERS: readonly string[]`, `class CsvFormatError extends Error`, `interface RawRow { line: number; cells: string[] }`, `parseCsv(buffer: Buffer): RawRow[]`.

`parseCsv` deliberately does **not** judge row content. Rows with the wrong number of cells are returned as-is; Task 3 turns them into `MALFORMED_ROW`. Only file-level problems (empty, bad header, unparseable) throw `CsvFormatError`, which the route maps to `400`.

- [ ] **Step 1: Create the failure-reason module**

Create `src/domain/reasons.ts`:

```ts
export const FailureReason = {
  MALFORMED_ROW: 'MALFORMED_ROW',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_DATE: 'INVALID_DATE',
  DUPLICATE_IN_FILE: 'DUPLICATE_IN_FILE',
  UPSTREAM_REJECTED: 'UPSTREAM_REJECTED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
} as const

export type FailureReason = (typeof FailureReason)[keyof typeof FailureReason]

export const ALL_FAILURE_REASONS = Object.values(FailureReason)

export interface RowFailure {
  line: number
  email: string | null
  reason: FailureReason
  detail: string
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/csv/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CsvFormatError, parseCsv } from '../../src/csv/parse.js'

const HEADER = 'name,email,start_date,country'
const buf = (s: string) => Buffer.from(s, 'utf8')

describe('parseCsv', () => {
  it('parses a simple file and numbers lines from the spreadsheet perspective', () => {
    const rows = parseCsv(buf(`${HEADER}\nAlice,alice@x.com,01/03/2026,SG\nBob,bob@x.com,02/03/2026,VN\n`))
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
    expect(() => parseCsv(buf('name,email,start,country\nA,a@x.com,01/03/2026,SG\n')))
      .toThrow(/header/i)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/csv/parse.test.ts`
Expected: FAIL — cannot resolve `../../src/csv/parse.js`.

- [ ] **Step 4: Write the implementation**

Create `src/csv/parse.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/csv/parse.test.ts`
Expected: PASS, 6 tests.

If the line numbers are off by one, check that `info: true` is set — `info.lines` is the physical line of the record and is what makes `line` match what ops sees in the spreadsheet.

- [ ] **Step 6: Commit**

```bash
git add src/domain/reasons.ts src/csv/parse.ts tests/csv/parse.test.ts
git commit -m "feat: parse employee CSV with spreadsheet line numbers"
```

---

### Task 3: Row validation

**Files:**
- Create: `src/domain/validate.ts`
- Test: `tests/domain/validate.test.ts`

**Interfaces:**
- Consumes: `RawRow` from `src/csv/parse.js`, `FailureReason` and `RowFailure` from `src/domain/reasons.js`.
- Produces: `interface EmployeeDraft { line: number; name: string; email: string; emailNormalized: string; startDate: string; country: string }`, `type ValidationResult = { ok: true; draft: EmployeeDraft } | { ok: false; failure: RowFailure }`, `validateRow(row: RawRow): ValidationResult`.

`startDate` on the draft is already ISO `YYYY-MM-DD`. Country is **not** checked against a list — the employee service is the authority, so a bad country comes back as `UPSTREAM_REJECTED`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateRow } from '../../src/domain/validate.js'
import type { RawRow } from '../../src/csv/parse.js'

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/validate.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/validate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/validate.ts`:

```ts
import type { RawRow } from '../csv/parse.js'
import { FailureReason, type RowFailure } from './reasons.js'

export interface EmployeeDraft {
  line: number
  name: string
  email: string
  emailNormalized: string
  startDate: string
  country: string
}

export type ValidationResult =
  | { ok: true; draft: EmployeeDraft }
  | { ok: false; failure: RowFailure }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/

/** Converts a strict DD/MM/YYYY string to ISO YYYY-MM-DD, or null if it is not a real date. */
export function toIsoDate(value: string): string | null {
  const m = DATE_RE.exec(value)
  if (!m) return null
  const [, dd, mm, yyyy] = m as unknown as [string, string, string, string]
  const day = Number(dd)
  const month = Number(mm)
  const year = Number(yyyy)
  const d = new Date(Date.UTC(year, month - 1, day))
  // Round-trip check: Date rolls 31/02 forward to 03/03, so comparing the parts back
  // is what rejects days that do not exist.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null
  }
  return `${yyyy}-${mm}-${dd}`
}

function fail(line: number, email: string | null, reason: RowFailure['reason'], detail: string): ValidationResult {
  return { ok: false, failure: { line, email, reason, detail } }
}

export function validateRow(row: RawRow): ValidationResult {
  if (row.cells.length !== 4) {
    return fail(
      row.line,
      null,
      FailureReason.MALFORMED_ROW,
      `expected 4 columns, got ${row.cells.length}`,
    )
  }

  const [name, email, startDate, country] = row.cells.map((c) => c.trim()) as [
    string, string, string, string,
  ]
  const emailForReport = email === '' ? null : email

  const fields: Array<[string, string]> = [
    ['name', name],
    ['email', email],
    ['start_date', startDate],
    ['country', country],
  ]
  for (const [label, value] of fields) {
    if (value === '') {
      return fail(row.line, emailForReport, FailureReason.MISSING_FIELD, `${label} is required`)
    }
  }

  if (!EMAIL_RE.test(email)) {
    return fail(row.line, email, FailureReason.INVALID_EMAIL, `email '${email}' is not a valid address`)
  }

  const iso = toIsoDate(startDate)
  if (iso === null) {
    return fail(
      row.line,
      email,
      FailureReason.INVALID_DATE,
      `start_date '${startDate}' is not a real DD/MM/YYYY date`,
    )
  }

  return {
    ok: true,
    draft: {
      line: row.line,
      name,
      email,
      emailNormalized: email.toLowerCase(),
      startDate: iso,
      country,
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/validate.ts tests/domain/validate.test.ts
git commit -m "feat: validate CSV rows with strict DD/MM/YYYY dates"
```

---

### Task 4: In-file deduplication

**Files:**
- Create: `src/domain/dedupe.ts`
- Test: `tests/domain/dedupe.test.ts`

**Interfaces:**
- Consumes: `EmployeeDraft` from `src/domain/validate.js`, `RowFailure` from `src/domain/reasons.js`.
- Produces: `dedupeByEmail(drafts: EmployeeDraft[]): { kept: EmployeeDraft[]; duplicates: RowFailure[] }`.

First occurrence wins. Every later occurrence becomes a `DUPLICATE_IN_FILE` failure carrying **its own** line number and a detail naming the line that won.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/dedupe.test.ts`:

```ts
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
    expect(duplicates[0]!.email).toBe('a@x.com')
  })

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const { kept, duplicates } = dedupeByEmail([draft(2, 'Alice@X.com'), draft(3, ' alice@x.com ')])
    expect(kept).toHaveLength(1)
    expect(duplicates[0]!.line).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/dedupe.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/dedupe.js`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/dedupe.ts`:

```ts
import { FailureReason, type RowFailure } from './reasons.js'
import type { EmployeeDraft } from './validate.js'

export function dedupeByEmail(drafts: EmployeeDraft[]): {
  kept: EmployeeDraft[]
  duplicates: RowFailure[]
} {
  const seen = new Map<string, number>()
  const kept: EmployeeDraft[] = []
  const duplicates: RowFailure[] = []

  for (const d of drafts) {
    const key = d.emailNormalized.trim().toLowerCase()
    const winner = seen.get(key)
    if (winner !== undefined) {
      duplicates.push({
        line: d.line,
        email: d.email,
        reason: FailureReason.DUPLICATE_IN_FILE,
        detail: `email '${key}' already appears on line ${winner}`,
      })
      continue
    }
    seen.set(key, d.line)
    kept.push(d)
  }

  return { kept, duplicates }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/dedupe.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/dedupe.ts tests/domain/dedupe.test.ts
git commit -m "feat: dedupe rows by normalized email, first occurrence wins"
```

---

### Task 5: Mongoose models and the Mongo test harness

**Files:**
- Create: `src/store/models/import.ts`, `src/store/models/importRow.ts`, `src/store/connection.ts`
- Create: `tests/helpers/mongo.ts`
- Test: `tests/store/models.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.js`.
- Produces:
  - `ImportModel` and `type ImportStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS'` from `src/store/models/import.js`.
  - `ImportRowModel` and `type RowStatus = 'PENDING' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED'` from `src/store/models/importRow.js`.
  - `connectMongo(uri: string, dbName: string): Promise<void>` and `disconnectMongo(): Promise<void>` from `src/store/connection.js`. `connectMongo` calls `syncIndexes()` on both models.
  - `tests/helpers/mongo.ts`: `useMongo(): void` — registers the Vitest lifecycle hooks for a test file.

Two things that will bite if done the obvious way:

- **`autoIndex: false` plus an explicit `syncIndexes()`.** Mongoose otherwise builds indexes lazily in the background, which races the first insert. The partial unique index must exist before any row is written.
- **Clear collections with `deleteMany({})` between tests, never `dropDatabase()`.** Dropping the database also drops the indexes, and the very thing several later tests assert is that an index rejects a duplicate.

- [ ] **Step 1: Create the `Import` model**

Create `src/store/models/import.ts`:

```ts
import { Schema, model, type InferSchemaType } from 'mongoose'

export const IMPORT_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]

const ImportSchema = new Schema(
  {
    filename: { type: String, required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: 'QUEUED', required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

ImportSchema.index({ status: 1, createdAt: 1 })

export type ImportDoc = InferSchemaType<typeof ImportSchema>
export const ImportModel = model('Import', ImportSchema)
```

- [ ] **Step 2: Create the `ImportRow` model**

Create `src/store/models/importRow.ts`:

```ts
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

export const ROW_STATUSES = ['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED'] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

const ImportRowSchema = new Schema(
  {
    importId: { type: Schema.Types.ObjectId, ref: 'Import', required: true },
    line: { type: Number, required: true },
    status: { type: String, enum: ROW_STATUSES, default: 'PENDING', required: true },
    payload: {
      name: { type: String, required: true },
      email: { type: String, required: true },
      startDate: { type: String, required: true },
      country: { type: String, required: true },
    },
    emailNormalized: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    claimId: { type: Schema.Types.ObjectId, default: null },
    claimedAt: { type: Date, default: null },
    reason: { type: String, default: null },
    detail: { type: String, default: null },
  },
  { timestamps: true },
)

ImportRowSchema.index({ importId: 1, status: 1 })
ImportRowSchema.index({ claimId: 1 })
// Safety net beneath the application-level dedupe. Partial on non-FAILED so a row that was
// already rejected as a duplicate can still be stored for reporting.
ImportRowSchema.index(
  { importId: 1, emailNormalized: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'FAILED' } } },
)

export type ImportRowDoc = InferSchemaType<typeof ImportRowSchema> & { _id: Types.ObjectId }
export const ImportRowModel = model('ImportRow', ImportRowSchema)
```

- [ ] **Step 3: Create the connection module**

Create `src/store/connection.ts`:

```ts
import mongoose from 'mongoose'
import { ImportModel } from './models/import.js'
import { ImportRowModel } from './models/importRow.js'

export async function connectMongo(uri: string, dbName: string): Promise<void> {
  await mongoose.connect(uri, { dbName, autoIndex: false })
  await syncIndexes()
}

/** Builds every declared index. Must run before the first insert. */
export async function syncIndexes(): Promise<void> {
  await ImportModel.syncIndexes()
  await ImportRowModel.syncIndexes()
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect()
}
```

- [ ] **Step 4: Create the test harness**

Create `tests/helpers/mongo.ts`:

```ts
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { syncIndexes } from '../../src/store/connection.js'

/**
 * Boots an in-memory mongod for the calling test file and registers cleanup.
 * Collections are emptied between tests with deleteMany rather than dropDatabase,
 * because dropping the database also drops the indexes that several tests assert on.
 */
export function useMongo(): void {
  let mongod: MongoMemoryServer

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    await mongoose.connect(mongod.getUri(), { dbName: 'test', autoIndex: false })
    await syncIndexes()
  })

  afterEach(async () => {
    const collections = mongoose.connection.collections
    for (const name of Object.keys(collections)) {
      await collections[name]!.deleteMany({})
    }
  })

  afterAll(async () => {
    await mongoose.disconnect()
    await mongod.stop()
  })
}
```

- [ ] **Step 5: Write the failing test**

Create `tests/store/models.test.ts`:

```ts
import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { ImportModel } from '../../src/store/models/import.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const rowFor = (importId: Types.ObjectId, over: Record<string, unknown> = {}) => ({
  importId,
  line: 2,
  payload: { name: 'Alice', email: 'a@x.com', startDate: '2026-03-01', country: 'SG' },
  emailNormalized: 'a@x.com',
  ...over,
})

describe('models', () => {
  it('defaults a new import to QUEUED', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 3 })
    expect(imp.status).toBe('QUEUED')
    expect(imp.completedAt).toBeNull()
  })

  it('defaults a new row to PENDING with zero attempts', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 1 })
    const row = await ImportRowModel.create(rowFor(imp._id))
    expect(row.status).toBe('PENDING')
    expect(row.attempts).toBe(0)
    expect(row.claimId).toBeNull()
  })

  it('rejects a duplicate email within one import', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 2 })
    await ImportRowModel.create(rowFor(imp._id))
    await expect(ImportRowModel.create(rowFor(imp._id, { line: 3 }))).rejects.toThrow(/duplicate key/i)
  })

  it('allows a duplicate email when the new row is already FAILED', async () => {
    const imp = await ImportModel.create({ filename: 'a.csv', total: 2 })
    await ImportRowModel.create(rowFor(imp._id))
    await expect(
      ImportRowModel.create(
        rowFor(imp._id, { line: 3, status: 'FAILED', reason: 'DUPLICATE_IN_FILE', detail: 'dupe' }),
      ),
    ).resolves.toBeDefined()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/store/models.test.ts`
Expected: FAIL — modules not found (or, if the models exist but `syncIndexes` was skipped, the duplicate-key tests fail because the index has not been built).

- [ ] **Step 7: Run the test to verify it passes**

The implementation is already written in steps 1-4. Run: `npx vitest run tests/store/models.test.ts`
Expected: PASS, 4 tests. The first run downloads a mongod binary and may take a minute.

- [ ] **Step 8: Commit**

```bash
git add src/store tests/helpers/mongo.ts tests/store/models.test.ts
git commit -m "feat: add Mongoose models with partial unique email index"
```

---

### Task 6: Repository — create and read

**Files:**
- Create: `src/store/importRepository.ts` (interface and shared types)
- Create: `src/store/mongooseRepository.ts` (partial: `createImport`, `getImport`)
- Test: `tests/store/repository-create-read.test.ts`

**Interfaces:**
- Consumes: models from Task 5, `EmployeeDraft` from Task 3, `RowFailure` from Task 2.
- Produces, from `src/store/importRepository.ts`:

```ts
export interface CreateImportInput {
  filename: string
  total: number
  drafts: EmployeeDraft[]
  failures: RowFailure[]
}

export interface ClaimedRow {
  id: string
  importId: string
  line: number
  attempts: number
  payload: { name: string; email: string; startDate: string; country: string }
}

export interface ImportSummary {
  importId: string
  status: ImportStatus
  total: number
  counts: { pending: number; inFlight: number; succeeded: number; failed: number }
  failures: RowFailure[]
  failuresTruncated: boolean
  createdAt: Date
  completedAt: Date | null
}

export const MAX_INLINE_FAILURES = 100

export interface ImportRepository {
  createImport(input: CreateImportInput): Promise<string>
  getImport(id: string): Promise<ImportSummary | null>
  reapStaleClaims(staleBefore: Date): Promise<number>
  claimBatch(limit: number): Promise<ClaimedRow[]>
  markSucceeded(rowId: string): Promise<void>
  markFailed(rowId: string, reason: FailureReason, detail: string): Promise<void>
  releaseForRetry(rowId: string): Promise<void>
  settleFinishedImports(): Promise<void>
}
```

  Task 6 implements `createImport` and `getImport`; Task 7 implements the rest on the same class.

- [ ] **Step 1: Create the interface module**

Create `src/store/importRepository.ts` with exactly the block shown in **Interfaces** above, preceded by these imports:

```ts
import type { FailureReason, RowFailure } from '../domain/reasons.js'
import type { EmployeeDraft } from '../domain/validate.js'
import type { ImportStatus } from './models/import.js'
```

- [ ] **Step 2: Write the failing test**

Create `tests/store/repository-create-read.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import type { EmployeeDraft } from '../../src/domain/validate.js'
import type { RowFailure } from '../../src/domain/reasons.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const repo = new MongooseImportRepository()

const draft = (line: number, email: string): EmployeeDraft => ({
  line,
  name: `Person ${line}`,
  email,
  emailNormalized: email.toLowerCase(),
  startDate: '2026-03-01',
  country: 'SG',
})

const failure = (line: number): RowFailure => ({
  line,
  email: null,
  reason: 'INVALID_DATE',
  detail: 'bad date',
})

describe('MongooseImportRepository create and read', () => {
  it('stores valid rows PENDING and invalid rows FAILED', async () => {
    const id = await repo.createImport({
      filename: 'a.csv',
      total: 3,
      drafts: [draft(2, 'a@x.com'), draft(3, 'b@x.com')],
      failures: [failure(4)],
    })
    expect(await ImportRowModel.countDocuments({ importId: id, status: 'PENDING' })).toBe(2)
    expect(await ImportRowModel.countDocuments({ importId: id, status: 'FAILED' })).toBe(1)
  })

  it('returns a summary with counts and failures', async () => {
    const id = await repo.createImport({
      filename: 'a.csv',
      total: 3,
      drafts: [draft(2, 'a@x.com'), draft(3, 'b@x.com')],
      failures: [failure(4)],
    })
    const s = await repo.getImport(id)
    expect(s).not.toBeNull()
    expect(s!.status).toBe('QUEUED')
    expect(s!.total).toBe(3)
    expect(s!.counts).toEqual({ pending: 2, inFlight: 0, succeeded: 0, failed: 1 })
    expect(s!.failures).toHaveLength(1)
    expect(s!.failures[0]!.line).toBe(4)
    expect(s!.failuresTruncated).toBe(false)
  })

  it('truncates the inline failure list at 100', async () => {
    const failures = Array.from({ length: 150 }, (_, i) => failure(i + 2))
    const id = await repo.createImport({ filename: 'a.csv', total: 150, drafts: [], failures })
    const s = await repo.getImport(id)
    expect(s!.failures).toHaveLength(100)
    expect(s!.failuresTruncated).toBe(true)
    expect(s!.counts.failed).toBe(150)
  })

  it('returns null for an unknown id', async () => {
    expect(await repo.getImport('66c1f0a3e4b0a1c2d3e4f5a6')).toBeNull()
  })

  it('returns null for a syntactically invalid id rather than throwing', async () => {
    expect(await repo.getImport('not-an-object-id')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/store/repository-create-read.test.ts`
Expected: FAIL — cannot resolve `mongooseRepository.js`.

- [ ] **Step 4: Write the implementation**

Create `src/store/mongooseRepository.ts`:

```ts
import { Types } from 'mongoose'
import type { FailureReason, RowFailure } from '../domain/reasons.js'
import type { EmployeeDraft } from '../domain/validate.js'
import {
  MAX_INLINE_FAILURES,
  type ClaimedRow,
  type CreateImportInput,
  type ImportRepository,
  type ImportSummary,
} from './importRepository.js'
import { ImportModel } from './models/import.js'
import { ImportRowModel } from './models/importRow.js'

const INSERT_CHUNK = 1000

function toObjectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null
}

export class MongooseImportRepository implements ImportRepository {
  async createImport(input: CreateImportInput): Promise<string> {
    const importId = new Types.ObjectId()

    const docs = [
      ...input.drafts.map((d: EmployeeDraft) => ({
        importId,
        line: d.line,
        status: 'PENDING' as const,
        payload: { name: d.name, email: d.email, startDate: d.startDate, country: d.country },
        emailNormalized: d.emailNormalized,
      })),
      ...input.failures.map((f: RowFailure) => ({
        importId,
        line: f.line,
        status: 'FAILED' as const,
        payload: { name: '', email: f.email ?? '', startDate: '', country: '' },
        emailNormalized: f.email?.toLowerCase() ?? `__invalid_line_${f.line}`,
        reason: f.reason,
        detail: f.detail,
      })),
    ]

    for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
      await ImportRowModel.insertMany(docs.slice(i, i + INSERT_CHUNK), { ordered: false })
    }

    // Written last: the cron must never see a half-inserted import.
    await ImportModel.create({
      _id: importId,
      filename: input.filename,
      total: input.total,
      status: 'QUEUED',
    })

    return importId.toHexString()
  }

  async getImport(id: string): Promise<ImportSummary | null> {
    const oid = toObjectId(id)
    if (!oid) return null

    const imp = await ImportModel.findById(oid).lean()
    if (!imp) return null

    const grouped = await ImportRowModel.aggregate<{ _id: string; n: number }>([
      { $match: { importId: oid } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    const by = (status: string) => grouped.find((g) => g._id === status)?.n ?? 0

    const failedDocs = await ImportRowModel.find({ importId: oid, status: 'FAILED' })
      .sort({ line: 1 })
      .limit(MAX_INLINE_FAILURES)
      .lean()

    const failedCount = by('FAILED')

    return {
      importId: id,
      status: imp.status,
      total: imp.total,
      counts: {
        pending: by('PENDING'),
        inFlight: by('IN_FLIGHT'),
        succeeded: by('SUCCEEDED'),
        failed: failedCount,
      },
      failures: failedDocs.map((d) => ({
        line: d.line,
        email: d.payload.email === '' ? null : d.payload.email,
        reason: d.reason as FailureReason,
        detail: d.detail ?? '',
      })),
      failuresTruncated: failedCount > MAX_INLINE_FAILURES,
      createdAt: imp.createdAt,
      completedAt: imp.completedAt ?? null,
    }
  }

  // Task 7 implements the remaining ImportRepository members on this class.
  async reapStaleClaims(_staleBefore: Date): Promise<number> {
    throw new Error('not implemented')
  }
  async claimBatch(_limit: number): Promise<ClaimedRow[]> {
    throw new Error('not implemented')
  }
  async markSucceeded(_rowId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async markFailed(_rowId: string, _reason: FailureReason, _detail: string): Promise<void> {
    throw new Error('not implemented')
  }
  async releaseForRetry(_rowId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async settleFinishedImports(): Promise<void> {
    throw new Error('not implemented')
  }
}
```

Note the `emailNormalized` fallback for failed rows without a parseable email: two `MALFORMED_ROW` rows in one file would otherwise collide on `''`. The partial index excludes `FAILED`, so this is belt-and-braces, but a per-line value costs nothing.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/store/repository-create-read.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/store/importRepository.ts src/store/mongooseRepository.ts tests/store/repository-create-read.test.ts
git commit -m "feat: persist imports and report status counts"
```

---

### Task 7: Repository — claim, reap, record, settle

**Files:**
- Modify: `src/store/mongooseRepository.ts` (replace the six `not implemented` stubs)
- Test: `tests/store/repository-claim.test.ts`

**Interfaces:**
- Consumes: everything from Task 6.
- Produces: working `reapStaleClaims`, `claimBatch`, `markSucceeded`, `markFailed`, `releaseForRetry`, `settleFinishedImports` — signatures exactly as declared in Task 6.

`claimBatch` picks the **oldest unfinished import** (`QUEUED` or `PROCESSING`, sorted by `createdAt`), claims up to `limit` of its `PENDING` rows, and flips that import to `PROCESSING`. It returns `[]` when there is nothing to do.

The claim is safe under concurrency because the `updateMany` filter repeats `status: 'PENDING'`: a competing worker that read the same ids matches nothing, and each worker then reads back only the rows carrying its own `claimId`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/repository-claim.test.ts`:

```ts
import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { ImportModel } from '../../src/store/models/import.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
import type { EmployeeDraft } from '../../src/domain/validate.js'
import { useMongo } from '../helpers/mongo.js'

useMongo()

const repo = new MongooseImportRepository()

const draft = (line: number): EmployeeDraft => ({
  line,
  name: `Person ${line}`,
  email: `p${line}@x.com`,
  emailNormalized: `p${line}@x.com`,
  startDate: '2026-03-01',
  country: 'SG',
})

async function seed(count: number, filename = 'a.csv'): Promise<string> {
  const drafts = Array.from({ length: count }, (_, i) => draft(i + 2))
  return repo.createImport({ filename, total: count, drafts, failures: [] })
}

describe('claimBatch', () => {
  it('returns an empty array when there is nothing pending', async () => {
    expect(await repo.claimBatch(10)).toEqual([])
  })

  it('claims no more than the limit', async () => {
    await seed(10)
    const batch = await repo.claimBatch(4)
    expect(batch).toHaveLength(4)
    expect(await ImportRowModel.countDocuments({ status: 'IN_FLIGHT' })).toBe(4)
    expect(await ImportRowModel.countDocuments({ status: 'PENDING' })).toBe(6)
  })

  it('returns the payload, line and attempts of each claimed row, and flips the import to PROCESSING', async () => {
    const id = await seed(1)
    const [row] = await repo.claimBatch(10)
    expect(row!.line).toBe(2)
    expect(row!.attempts).toBe(0)
    expect(row!.payload).toEqual({
      name: 'Person 2', email: 'p2@x.com', startDate: '2026-03-01', country: 'SG',
    })
    expect((await ImportModel.findById(id).lean())!.status).toBe('PROCESSING')
  })

  it('never hands the same row to two concurrent claimers', async () => {
    await seed(10)
    const [a, b] = await Promise.all([repo.claimBatch(10), repo.claimBatch(10)])
    const ids = [...a.map((r) => r.id), ...b.map((r) => r.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(10)
  })
})

describe('recording outcomes', () => {
  it('markSucceeded moves a row to SUCCEEDED and clears the claim', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.markSucceeded(row!.id)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('SUCCEEDED')
    expect(doc!.claimId).toBeNull()
  })

  it('markFailed records the reason and detail', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.markFailed(row!.id, 'UPSTREAM_REJECTED', 'employee-service 400: bad country')
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('FAILED')
    expect(doc!.reason).toBe('UPSTREAM_REJECTED')
    expect(doc!.detail).toContain('bad country')
  })

  it('releaseForRetry returns the row to PENDING and increments attempts', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await repo.releaseForRetry(row!.id)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('PENDING')
    expect(doc!.attempts).toBe(1)
    expect(doc!.claimId).toBeNull()
  })

})

describe('reapStaleClaims', () => {
  it('returns a stale IN_FLIGHT row to PENDING and increments attempts', async () => {
    await seed(1)
    const [row] = await repo.claimBatch(1)
    await ImportRowModel.updateOne({ _id: row!.id }, { $set: { claimedAt: new Date(Date.now() - 600_000) } })

    const reaped = await repo.reapStaleClaims(new Date(Date.now() - 300_000))
    expect(reaped).toBe(1)
    const doc = await ImportRowModel.findById(row!.id).lean()
    expect(doc!.status).toBe('PENDING')
    expect(doc!.attempts).toBe(1)
    expect(doc!.claimId).toBeNull()
  })

  it('leaves a fresh claim alone', async () => {
    await seed(1)
    await repo.claimBatch(1)
    expect(await repo.reapStaleClaims(new Date(Date.now() - 300_000))).toBe(0)
    expect(await ImportRowModel.countDocuments({ status: 'IN_FLIGHT' })).toBe(1)
  })

})

describe('settleFinishedImports', () => {
  it('marks an all-succeeded import COMPLETED with a completedAt', async () => {
    const id = await seed(2)
    for (const row of await repo.claimBatch(2)) await repo.markSucceeded(row.id)
    await repo.settleFinishedImports()
    const imp = await ImportModel.findById(id).lean()
    expect(imp!.status).toBe('COMPLETED')
    expect(imp!.completedAt).toBeInstanceOf(Date)
  })

  it('marks a partially failed import COMPLETED_WITH_ERRORS', async () => {
    const id = await seed(2)
    const batch = await repo.claimBatch(2)
    await repo.markSucceeded(batch[0]!.id)
    await repo.markFailed(batch[1]!.id, 'UPSTREAM_REJECTED', 'nope')
    await repo.settleFinishedImports()
    expect((await ImportModel.findById(id).lean())!.status).toBe('COMPLETED_WITH_ERRORS')
  })

  it('leaves an import alone while rows are still pending', async () => {
    const id = await seed(3)
    const batch = await repo.claimBatch(1)
    await repo.markSucceeded(batch[0]!.id)
    await repo.settleFinishedImports()
    expect((await ImportModel.findById(id).lean())!.status).toBe('PROCESSING')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/repository-claim.test.ts`
Expected: FAIL — every test throws "not implemented".

- [ ] **Step 3: Write the implementation**

In `src/store/mongooseRepository.ts`, replace the six stub methods with:

```ts
  async reapStaleClaims(staleBefore: Date): Promise<number> {
    const res = await ImportRowModel.updateMany(
      { status: 'IN_FLIGHT', claimedAt: { $lt: staleBefore } },
      { $set: { status: 'PENDING', claimId: null, claimedAt: null }, $inc: { attempts: 1 } },
    )
    return res.modifiedCount
  }

  async claimBatch(limit: number): Promise<ClaimedRow[]> {
    const imp = await ImportModel.findOne({ status: { $in: ['QUEUED', 'PROCESSING'] } })
      .sort({ createdAt: 1 })
      .lean()
    if (!imp) return []

    const candidates = await ImportRowModel.find({ importId: imp._id, status: 'PENDING' })
      .select('_id')
      .limit(limit)
      .lean()
    if (candidates.length === 0) return []

    const claimId = new Types.ObjectId()
    await ImportRowModel.updateMany(
      { _id: { $in: candidates.map((c) => c._id) }, status: 'PENDING' }, // the guard
      { $set: { status: 'IN_FLIGHT', claimId, claimedAt: new Date() } },
    )

    const claimed = await ImportRowModel.find({ claimId }).lean()
    if (claimed.length > 0 && imp.status === 'QUEUED') {
      await ImportModel.updateOne({ _id: imp._id }, { $set: { status: 'PROCESSING' } })
    }

    return claimed.map((r) => ({
      id: r._id.toHexString(),
      importId: r.importId.toHexString(),
      line: r.line,
      attempts: r.attempts,
      payload: {
        name: r.payload.name,
        email: r.payload.email,
        startDate: r.payload.startDate,
        country: r.payload.country,
      },
    }))
  }

  async markSucceeded(rowId: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'SUCCEEDED', claimId: null, claimedAt: null } },
    )
  }

  async markFailed(rowId: string, reason: FailureReason, detail: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'FAILED', reason, detail, claimId: null, claimedAt: null } },
    )
  }

  async releaseForRetry(rowId: string): Promise<void> {
    await ImportRowModel.updateOne(
      { _id: new Types.ObjectId(rowId) },
      { $set: { status: 'PENDING', claimId: null, claimedAt: null }, $inc: { attempts: 1 } },
    )
  }

  async settleFinishedImports(): Promise<void> {
    const active = await ImportModel.find({ status: { $in: ['QUEUED', 'PROCESSING'] } }).lean()
    for (const imp of active) {
      const remaining = await ImportRowModel.countDocuments({
        importId: imp._id,
        status: { $in: ['PENDING', 'IN_FLIGHT'] },
      })
      if (remaining > 0) continue
      const failed = await ImportRowModel.countDocuments({ importId: imp._id, status: 'FAILED' })
      await ImportModel.updateOne(
        { _id: imp._id },
        {
          $set: {
            status: failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
            completedAt: new Date(),
          },
        },
      )
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/store/`
Expected: PASS, all store tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/mongooseRepository.ts tests/store/repository-claim.test.ts
git commit -m "feat: atomic batch claiming, stale-claim reaper and import settlement"
```

---

### Task 8: Concurrency pool and employee service client

**Files:**
- Create: `src/client/pool.ts`, `src/client/employeeClient.ts`, `src/client/httpEmployeeClient.ts`
- Test: `tests/client/pool.test.ts`, `tests/client/httpEmployeeClient.test.ts`

**Interfaces:**
- Consumes: `FailureReason` from Task 2.
- Produces:
  - `src/client/pool.ts`: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` — preserves input order in the result.
  - `src/client/employeeClient.ts`:
    ```ts
    export interface EmployeePayload { name: string; email: string; startDate: string; country: string }
    export type CreateResult =
      | { ok: true }
      | { ok: false; retryable: boolean; reason: FailureReason; detail: string }
    export interface EmployeeClient { createEmployee(p: EmployeePayload): Promise<CreateResult> }
    ```
  - `src/client/httpEmployeeClient.ts`: `class HttpEmployeeClient implements EmployeeClient`, constructed as `new HttpEmployeeClient({ baseUrl, attempts?, baseDelayMs?, timeoutMs?, fetchImpl? })`.

`retryable: true` means the batch runner should return the row to `PENDING` for a later tick. The client has already exhausted its own in-tick retries by then — those cover transient blips, the cross-tick attempts cover longer outages.

- [ ] **Step 1: Write the failing pool test**

Create `tests/client/pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/client/pool.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([5, 1, 3], 2, async (n) => {
      await sleep(n)
      return n * 2
    })
    expect(out).toEqual([10, 2, 6])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/client/pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pool**

Create `src/client/pool.ts`:

```ts
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/client/pool.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Create the client interface**

Create `src/client/employeeClient.ts`:

```ts
import type { FailureReason } from '../domain/reasons.js'

export interface EmployeePayload {
  name: string
  email: string
  startDate: string
  country: string
}

export type CreateResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: FailureReason; detail: string }

export interface EmployeeClient {
  createEmployee(payload: EmployeePayload): Promise<CreateResult>
}
```

- [ ] **Step 6: Write the failing client test**

Create `tests/client/httpEmployeeClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { HttpEmployeeClient } from '../../src/client/httpEmployeeClient.js'
import type { EmployeePayload } from '../../src/client/employeeClient.js'

const payload: EmployeePayload = {
  name: 'Alice', email: 'Alice@X.com', startDate: '2026-03-01', country: 'SG',
}

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// baseDelayMs of 1 keeps retry tests fast without fake timers.
const client = (fetchImpl: typeof fetch) =>
  new HttpEmployeeClient({ baseUrl: 'http://svc', baseDelayMs: 1, fetchImpl })

describe('HttpEmployeeClient', () => {
  it('POSTs to /employees with the payload and an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => res(201, { id: 'e1' }))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)

    expect(r.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://svc/employees')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('alice@x.com')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('does not retry a 400 and reports UPSTREAM_REJECTED', async () => {
    const fetchImpl = vi.fn(async () => res(400, { message: "country 'XX' unsupported" }))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('UPSTREAM_REJECTED')
    expect(r.retryable).toBe(false)
    expect(r.detail).toContain('400')
    expect(r.detail).toContain('unsupported')
  })

  it('retries a 429 and succeeds on the second attempt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(201))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('retries a 503 then reports UPSTREAM_UNAVAILABLE as retryable', async () => {
    const fetchImpl = vi.fn(async () => res(503))
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('UPSTREAM_UNAVAILABLE')
    expect(r.retryable).toBe(true)
  })

  it('retries a network error then reports UPSTREAM_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const r = await client(fetchImpl as unknown as typeof fetch).createEmployee(payload)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('UPSTREAM_UNAVAILABLE')
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/client/httpEmployeeClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the client**

Create `src/client/httpEmployeeClient.ts`:

```ts
import { FailureReason } from '../domain/reasons.js'
import type { CreateResult, EmployeeClient, EmployeePayload } from './employeeClient.js'

export interface HttpEmployeeClientOptions {
  baseUrl: string
  attempts?: number
  baseDelayMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class HttpEmployeeClient implements EmployeeClient {
  private readonly baseUrl: string
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpEmployeeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.attempts = opts.attempts ?? 3
    this.baseDelayMs = opts.baseDelayMs ?? 200
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async createEmployee(payload: EmployeePayload): Promise<CreateResult> {
    let lastDetail = 'no attempt was made'

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/employees`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': payload.email.trim().toLowerCase(),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        })

        if (response.ok) return { ok: true }

        const body = await response.text().catch(() => '')
        const detail = `employee-service ${response.status}: ${summarize(body)}`

        // 4xx other than 429 is a verdict, not a blip. Retrying it is pointless.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return { ok: false, retryable: false, reason: FailureReason.UPSTREAM_REJECTED, detail }
        }
        lastDetail = detail
      } catch (err) {
        lastDetail = `employee-service unreachable: ${(err as Error).message}`
      }

      if (attempt < this.attempts) {
        const backoff = this.baseDelayMs * 2 ** (attempt - 1)
        await sleep(backoff + Math.floor(Math.random() * this.baseDelayMs))
      }
    }

    return {
      ok: false,
      retryable: true,
      reason: FailureReason.UPSTREAM_UNAVAILABLE,
      detail: `${lastDetail} (after ${this.attempts} attempts)`,
    }
  }
}

function summarize(body: string): string {
  if (body === '') return '(empty body)'
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? body.slice(0, 200)
  } catch {
    return body.slice(0, 200)
  }
}
```

- [ ] **Step 9: Run the client tests to verify they pass**

Run: `npx vitest run tests/client/`
Expected: PASS, 8 tests.

- [ ] **Step 10: Commit**

```bash
git add src/client tests/client
git commit -m "feat: employee service client with retry, backoff and idempotency key"
```

---

### Task 9: Upload orchestrator

**Files:**
- Create: `src/domain/upload.ts`
- Test: `tests/domain/upload.test.ts`

**Interfaces:**
- Consumes: `parseCsv` / `CsvFormatError` (Task 2), `validateRow` (Task 3), `dedupeByEmail` (Task 4), `ImportRepository` (Task 6).
- Produces:
  ```ts
  export class TooManyRowsError extends Error {}
  export interface UploadResult {
    importId: string
    total: number
    accepted: number
    rejected: number
    failures: RowFailure[]
  }
  export function processUpload(
    buffer: Buffer, filename: string, repo: ImportRepository, maxRows: number,
  ): Promise<UploadResult>
  ```

`CsvFormatError` propagates for the route to map to `400`; `TooManyRowsError` maps to `413`. `failures` in the result is the full list; the route truncates for the response.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/upload.test.ts`. It uses an in-memory fake repository — no database:

```ts
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
  return processUpload(buf(csv), 'a.csv', repo as ImportRepository, maxRows).then((r) => ({ r, repo }))
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
    const { r } = await run(
      `${HEADER}\nAlice,a@x.com,01/03/2026,SG\nBob,b@x.com,31/02/2026,VN\n`,
    )
    expect(r).toMatchObject({ total: 2, accepted: 1, rejected: 1 })
    expect(r.failures[0]).toMatchObject({ line: 3, reason: 'INVALID_DATE' })
  })

  it('reports in-file duplicates as failures', async () => {
    const { r } = await run(
      `${HEADER}\nAlice,a@x.com,01/03/2026,SG\nAlice2,A@X.com,02/03/2026,SG\n`,
    )
    expect(r).toMatchObject({ total: 2, accepted: 1, rejected: 1 })
    expect(r.failures[0]).toMatchObject({ line: 3, reason: 'DUPLICATE_IN_FILE' })
  })

  it('sorts all failures by line regardless of which check produced them', async () => {
    const { r } = await run(
      `${HEADER}\nA,a@x.com,01/03/2026,SG\nB,bad-email,01/03/2026,SG\nC,a@x.com,01/03/2026,SG\nD,d@x.com,31/02/2026,SG\n`,
    )
    expect(r.failures.map((f) => f.line)).toEqual([3, 4, 5])
    expect(r.failures.map((f) => f.reason)).toEqual([
      'INVALID_EMAIL', 'DUPLICATE_IN_FILE', 'INVALID_DATE',
    ])
  })

  it('passes both drafts and failures to the repository', async () => {
    const { repo } = await run(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,31/02/2026,SG\n`)
    expect(repo.last!.drafts).toHaveLength(1)
    expect(repo.last!.failures).toHaveLength(1)
    expect(repo.last!.total).toBe(2)
  })

  it('accepts a header-only file as an empty import', async () => {
    const { r } = await run(`${HEADER}\n`)
    expect(r).toMatchObject({ total: 0, accepted: 0, rejected: 0 })
  })

  it('propagates CsvFormatError for a bad header', async () => {
    await expect(run('wrong,header\n')).rejects.toThrow(CsvFormatError)
  })

  it('throws TooManyRowsError past the row cap', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `P${i},p${i}@x.com,01/03/2026,SG`).join('\n')
    await expect(run(`${HEADER}\n${rows}\n`, 3)).rejects.toThrow(TooManyRowsError)
  })

  it('does not create an import when the row cap is exceeded', async () => {
    const repo = new FakeRepo()
    const rows = Array.from({ length: 5 }, (_, i) => `P${i},p${i}@x.com,01/03/2026,SG`).join('\n')
    await expect(
      processUpload(buf(`${HEADER}\n${rows}\n`), 'a.csv', repo as ImportRepository, 3),
    ).rejects.toThrow(TooManyRowsError)
    expect(repo.last).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/upload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/domain/upload.ts`:

```ts
import { parseCsv } from '../csv/parse.js'
import type { ImportRepository } from '../store/importRepository.js'
import { dedupeByEmail } from './dedupe.js'
import type { RowFailure } from './reasons.js'
import { validateRow } from './validate.js'
import type { EmployeeDraft } from './validate.js'

export class TooManyRowsError extends Error {
  constructor(rows: number, max: number) {
    super(`file has ${rows} rows, the maximum is ${max}`)
    this.name = 'TooManyRowsError'
  }
}

export interface UploadResult {
  importId: string
  total: number
  accepted: number
  rejected: number
  failures: RowFailure[]
}

export async function processUpload(
  buffer: Buffer,
  filename: string,
  repo: ImportRepository,
  maxRows: number,
): Promise<UploadResult> {
  const rows = parseCsv(buffer)
  if (rows.length > maxRows) throw new TooManyRowsError(rows.length, maxRows)

  const drafts: EmployeeDraft[] = []
  const failures: RowFailure[] = []

  for (const row of rows) {
    const result = validateRow(row)
    if (result.ok) drafts.push(result.draft)
    else failures.push(result.failure)
  }

  const { kept, duplicates } = dedupeByEmail(drafts)
  failures.push(...duplicates)
  failures.sort((a, b) => a.line - b.line)

  const importId = await repo.createImport({
    filename,
    total: rows.length,
    drafts: kept,
    failures,
  })

  return {
    importId,
    total: rows.length,
    accepted: kept.length,
    rejected: failures.length,
    failures,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/upload.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/upload.ts tests/domain/upload.test.ts
git commit -m "feat: upload orchestrator wiring parse, validate, dedupe and persist"
```

---

### Task 10: Batch runner

**Files:**
- Create: `src/jobs/batchRunner.ts`
- Test: `tests/jobs/batchRunner.test.ts`

**Interfaces:**
- Consumes: `ImportRepository` (Tasks 6-7), `EmployeeClient` (Task 8), `mapWithConcurrency` (Task 8).
- Produces:
  ```ts
  export interface BatchRunnerDeps {
    repo: ImportRepository
    client: EmployeeClient
    batchSize: number
    concurrency: number
    maxAttempts: number
    staleClaimMs: number
    now?: () => Date
  }
  export interface BatchStats { claimed: number; succeeded: number; failed: number; retried: number; reaped: number; skipped: boolean }
  export function createBatchRunner(deps: BatchRunnerDeps): { runBatch(): Promise<BatchStats> }
  ```

`createBatchRunner` returns an object holding the overlap guard as **instance** state, not a module-level flag. Same behaviour, but each test gets a clean runner instead of leaking a boolean between tests.

Tick order: reap → claim → dispatch → record → settle. `skipped: true` means the guard rejected a re-entrant call.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/batchRunner.test.ts`. It uses fakes for both the repository and the client — no database, no network:

```ts
import { describe, expect, it } from 'vitest'
import type { CreateResult, EmployeeClient, EmployeePayload } from '../../src/client/employeeClient.js'
import type { FailureReason } from '../../src/domain/reasons.js'
import { createBatchRunner } from '../../src/jobs/batchRunner.js'
import type { ClaimedRow, ImportRepository } from '../../src/store/importRepository.js'

interface Recorded { id: string; kind: 'ok' | 'fail' | 'retry'; reason?: FailureReason }

class FakeRepo implements Partial<ImportRepository> {
  public rows: ClaimedRow[] = []
  public recorded: Recorded[] = []
  public reaped = 0
  public settled = 0
  public reapArgs: Date[] = []

  async reapStaleClaims(staleBefore: Date): Promise<number> {
    this.reapArgs.push(staleBefore)
    return this.reaped
  }
  async claimBatch(limit: number): Promise<ClaimedRow[]> {
    return this.rows.splice(0, limit)
  }
  async markSucceeded(id: string): Promise<void> {
    this.recorded.push({ id, kind: 'ok' })
  }
  async markFailed(id: string, reason: FailureReason): Promise<void> {
    this.recorded.push({ id, kind: 'fail', reason })
  }
  async releaseForRetry(id: string): Promise<void> {
    this.recorded.push({ id, kind: 'retry' })
  }
  async settleFinishedImports(): Promise<void> {
    this.settled += 1
  }
}

class FakeClient implements EmployeeClient {
  constructor(private readonly reply: (p: EmployeePayload) => CreateResult) {}
  public calls: EmployeePayload[] = []
  async createEmployee(p: EmployeePayload): Promise<CreateResult> {
    this.calls.push(p)
    return this.reply(p)
  }
}

const row = (id: string, attempts = 0): ClaimedRow => ({
  id,
  importId: 'imp_1',
  line: 2,
  attempts,
  payload: { name: 'A', email: `${id}@x.com`, startDate: '2026-03-01', country: 'SG' },
})

const runnerWith = (repo: FakeRepo, client: EmployeeClient, over: Partial<{ maxAttempts: number }> = {}) =>
  createBatchRunner({
    repo: repo as unknown as ImportRepository,
    client,
    batchSize: 50,
    concurrency: 5,
    maxAttempts: over.maxAttempts ?? 3,
    staleClaimMs: 300_000,
  })

describe('runBatch', () => {
  it('marks a successful row SUCCEEDED', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    const stats = await runnerWith(repo, new FakeClient(() => ({ ok: true }))).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'ok' }])
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 })
  })

  it('marks a non-retryable rejection FAILED and never retries it', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    const client = new FakeClient(() => ({
      ok: false, retryable: false, reason: 'UPSTREAM_REJECTED', detail: 'bad country',
    }))
    await runnerWith(repo, client).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'fail', reason: 'UPSTREAM_REJECTED' }])
    expect(client.calls).toHaveLength(1)
  })

  it('releases a retryable failure for a later tick when attempts remain', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1', 0)]
    const client = new FakeClient(() => ({
      ok: false, retryable: true, reason: 'UPSTREAM_UNAVAILABLE', detail: '503',
    }))
    const stats = await runnerWith(repo, client).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'retry' }])
    expect(stats.retried).toBe(1)
  })

  it('terminates a retryable failure once attempts are exhausted', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1', 2)] // this attempt is the third
    const client = new FakeClient(() => ({
      ok: false, retryable: true, reason: 'UPSTREAM_UNAVAILABLE', detail: '503',
    }))
    const stats = await runnerWith(repo, client, { maxAttempts: 3 }).runBatch()

    expect(repo.recorded).toEqual([{ id: 'r1', kind: 'fail', reason: 'UPSTREAM_UNAVAILABLE' }])
    expect(stats.failed).toBe(1)
    expect(stats.retried).toBe(0)
  })

  it('handles a mixed batch, reaps first and settles at the end', async () => {
    const repo = new FakeRepo()
    repo.reaped = 4
    repo.rows = [row('ok1'), row('bad1'), row('flaky1')]
    const client = new FakeClient((p) => {
      if (p.email.startsWith('bad')) {
        return { ok: false, retryable: false, reason: 'UPSTREAM_REJECTED', detail: 'no' }
      }
      if (p.email.startsWith('flaky')) {
        return { ok: false, retryable: true, reason: 'UPSTREAM_UNAVAILABLE', detail: '503' }
      }
      return { ok: true }
    })
    const stats = await runnerWith(repo, client).runBatch()
    expect(stats).toMatchObject({ claimed: 3, succeeded: 1, failed: 1, retried: 1, reaped: 4 })
    expect(repo.reapArgs).toHaveLength(1)
    expect(repo.settled).toBe(1)
  })

  it('skips a re-entrant call while a tick is still in flight', async () => {
    const repo = new FakeRepo()
    repo.rows = [row('r1')]
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const client: EmployeeClient = {
      createEmployee: async () => { await gate; return { ok: true } },
    }
    const runner = runnerWith(repo, client)

    const first = runner.runBatch()
    const second = await runner.runBatch()
    expect(second.skipped).toBe(true)
    expect(second.claimed).toBe(0)

    release()
    expect((await first).claimed).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/jobs/batchRunner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/jobs/batchRunner.ts`:

```ts
import type { EmployeeClient } from '../client/employeeClient.js'
import { mapWithConcurrency } from '../client/pool.js'
import type { ClaimedRow, ImportRepository } from '../store/importRepository.js'

export interface BatchRunnerDeps {
  repo: ImportRepository
  client: EmployeeClient
  batchSize: number
  concurrency: number
  maxAttempts: number
  staleClaimMs: number
  now?: () => Date
}

export interface BatchStats {
  claimed: number
  succeeded: number
  failed: number
  retried: number
  reaped: number
  skipped: boolean
}

type Outcome = 'succeeded' | 'failed' | 'retried'

export function createBatchRunner(deps: BatchRunnerDeps): { runBatch(): Promise<BatchStats> } {
  const now = deps.now ?? (() => new Date())
  // Instance state rather than a module-level flag: each runner (and each test) is independent.
  let running = false

  async function dispatch(row: ClaimedRow): Promise<Outcome> {
    const result = await deps.client.createEmployee(row.payload)

    if (result.ok) {
      await deps.repo.markSucceeded(row.id)
      return 'succeeded'
    }

    const attemptsUsed = row.attempts + 1
    if (result.retryable && attemptsUsed < deps.maxAttempts) {
      await deps.repo.releaseForRetry(row.id)
      return 'retried'
    }

    await deps.repo.markFailed(row.id, result.reason, result.detail)
    return 'failed'
  }

  async function runBatch(): Promise<BatchStats> {
    if (running) {
      return { claimed: 0, succeeded: 0, failed: 0, retried: 0, reaped: 0, skipped: true }
    }
    running = true
    try {
      const staleBefore = new Date(now().getTime() - deps.staleClaimMs)
      const reaped = await deps.repo.reapStaleClaims(staleBefore)

      const batch = await deps.repo.claimBatch(deps.batchSize)
      const outcomes = await mapWithConcurrency(batch, deps.concurrency, dispatch)

      await deps.repo.settleFinishedImports()

      return {
        claimed: batch.length,
        succeeded: outcomes.filter((o) => o === 'succeeded').length,
        failed: outcomes.filter((o) => o === 'failed').length,
        retried: outcomes.filter((o) => o === 'retried').length,
        reaped,
        skipped: false,
      }
    } finally {
      running = false
    }
  }

  return { runBatch }
}
```

The `finally` is what makes the guard safe: a throwing tick that left `running = true` would wedge the cron forever.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/jobs/batchRunner.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/batchRunner.ts tests/jobs/batchRunner.test.ts
git commit -m "feat: batch runner with reaper, overlap guard and cross-tick retry"
```

---

### Task 11: Cron scheduler

**Files:**
- Create: `src/jobs/scheduler.ts`
- Test: `tests/jobs/scheduler.test.ts`

**Interfaces:**
- Consumes: nothing but a callback.
- Produces: `startScheduler(schedule: string, task: () => Promise<unknown>): ScheduledTask` where `ScheduledTask` is `node-cron`'s type, re-exported.

Thin by design. `runBatch` is tested directly in Task 10; this only proves the wiring and that a rejected tick is caught rather than becoming an unhandled rejection that kills the process.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/scheduler.test.ts`:

```ts
import cron from 'node-cron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from '../../src/jobs/scheduler.js'

afterEach(() => { vi.restoreAllMocks() })

describe('startScheduler', () => {
  it('rejects an invalid cron expression', () => {
    expect(() => startScheduler('not a cron', async () => {})).toThrow(/cron/i)
  })

  it('registers the schedule and invokes the task when the callback fires', async () => {
    let fire: () => void = () => {}
    const stub = { stop: vi.fn() } as unknown as cron.ScheduledTask
    const schedule = vi.spyOn(cron, 'schedule').mockImplementation((_expr, cb) => {
      fire = cb as () => void
      return stub
    })

    const task = vi.fn(async () => {})
    startScheduler('*/10 * * * * *', task)

    expect(schedule.mock.calls[0]![0]).toBe('*/10 * * * * *')
    fire()
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/jobs/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/jobs/scheduler.ts`:

```ts
import cron, { type ScheduledTask } from 'node-cron'

export type { ScheduledTask }

export function startScheduler(
  schedule: string,
  task: () => Promise<unknown>,
  onError: (err: Error) => void = (err) => console.error('[cron] tick failed:', err.message),
): ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`invalid cron expression: "${schedule}"`)
  }
  return cron.schedule(schedule, () => {
    // node-cron ignores the returned promise, so an unhandled rejection here would
    // otherwise take the process down.
    void task().catch((err: unknown) => onError(err as Error))
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/jobs/scheduler.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/scheduler.ts tests/jobs/scheduler.test.ts
git commit -m "feat: node-cron scheduler wrapper with tick error isolation"
```

---

### Task 12: HTTP routes and server

**Files:**
- Create: `src/http/server.ts`, `src/http/routes.ts`
- Test: `tests/http/routes.test.ts`

**Interfaces:**
- Consumes: `processUpload` / `TooManyRowsError` (Task 9), `CsvFormatError` (Task 2), `ImportRepository` / `MAX_INLINE_FAILURES` (Task 6), `Config` (Task 1).
- Produces: `buildServer(deps: { repo: ImportRepository; config: Config }): Promise<FastifyInstance>`.

Routes hold no logic — they translate between HTTP and the domain, and map errors to status codes:

| Thrown | Status |
|---|---|
| `CsvFormatError` | `400` |
| `TooManyRowsError` | `413` |
| Fastify multipart `FST_REQ_FILE_TOO_LARGE` | `413` |
| missing `file` field | `400` |

- [ ] **Step 1: Write the failing test**

Create `tests/http/routes.test.ts`. It uses Fastify's `inject`, so no port is bound:

```ts
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { buildServer } from '../../src/http/server.js'
import { MongooseImportRepository } from '../../src/store/mongooseRepository.js'
import { ImportRowModel } from '../../src/store/models/importRow.js'
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
afterEach(async () => { await app.close() })

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
    const { importId } = (await post(`${HEADER}\nA,a@x.com,01/03/2026,SG\nB,b@x.com,31/02/2026,SG\n`)).json()
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/http/routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the routes**

Create `src/http/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { CsvFormatError } from '../csv/parse.js'
import { TooManyRowsError, processUpload } from '../domain/upload.js'
import { MAX_INLINE_FAILURES, type ImportRepository } from '../store/importRepository.js'

export interface RouteDeps {
  repo: ImportRepository
  config: Config
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }))

  app.post('/imports', async (request, reply) => {
    let file
    try {
      file = await request.file()
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          reason: 'TOO_LARGE',
          detail: `file exceeds ${deps.config.maxFileBytes} bytes`,
        })
      }
      throw err
    }

    if (!file) {
      return reply.code(400).send({ reason: 'MISSING_FILE', detail: 'expected a file field named "file"' })
    }

    let buffer: Buffer
    try {
      buffer = await file.toBuffer()
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          reason: 'TOO_LARGE',
          detail: `file exceeds ${deps.config.maxFileBytes} bytes`,
        })
      }
      throw err
    }

    try {
      const result = await processUpload(buffer, file.filename, deps.repo, deps.config.maxRows)
      return reply.code(202).send({
        importId: result.importId,
        total: result.total,
        accepted: result.accepted,
        rejected: result.rejected,
        failures: result.failures.slice(0, MAX_INLINE_FAILURES),
        failuresTruncated: result.failures.length > MAX_INLINE_FAILURES,
        statusUrl: `/imports/${result.importId}/status`,
      })
    } catch (err) {
      if (err instanceof CsvFormatError) {
        return reply.code(400).send({ reason: 'INVALID_CSV', detail: err.message })
      }
      if (err instanceof TooManyRowsError) {
        return reply.code(413).send({ reason: 'TOO_LARGE', detail: err.message })
      }
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/imports/:id/status', async (request, reply) => {
    const summary = await deps.repo.getImport(request.params.id)
    if (!summary) {
      return reply.code(404).send({ reason: 'NOT_FOUND', detail: `no import with id ${request.params.id}` })
    }
    return reply.code(200).send(summary)
  })
}
```

- [ ] **Step 4: Write the server**

Create `src/http/server.ts`:

```ts
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { ImportRepository } from '../store/importRepository.js'
import { registerRoutes } from './routes.js'

export interface ServerDeps {
  repo: ImportRepository
  config: Config
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: deps.config.maxFileBytes })

  await app.register(multipart, {
    limits: { fileSize: deps.config.maxFileBytes, files: 1 },
  })
  await registerRoutes(app, deps)
  await app.ready()

  return app
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/http/routes.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 7: Commit**

```bash
git add src/http tests/http
git commit -m "feat: HTTP upload and status endpoints"
```

---

### Task 13: Mock upstream employee service

**Files:**
- Create: `src/mock/server.ts`
- Test: `tests/mock/server.test.ts`

**Interfaces:**
- Consumes: nothing from the main application. This is a standalone stand-in for the real employee service and must not import from `src/domain`, `src/store`, or `src/client`.
- Produces: `buildMockEmployeeService(): FastifyInstance` and, when run directly via `npm run mock`, a server on `MOCK_PORT` (default 4000).

Behaviour, chosen so an end-to-end Postman run can demonstrate every failure path deterministically — no randomness:

| Route | Behaviour |
|---|---|
| `POST /employees` | creates an employee, `201` |
| `GET /employees` | lists everything created, for inspection |
| `DELETE /employees` | clears the store, to reset between runs |
| `GET /health` | `{ status: 'ok' }` |

Rules:

- Requires `name`, `email`, `startDate`, `country`; a missing field is `400`.
- `country` must be in a small supported set — anything else is `400`, which is how a Postman run demonstrates `UPSTREAM_REJECTED`.
- **Honors `Idempotency-Key`**: a repeat of a seen key returns `200` with the original employee and creates nothing new. This is the contract the whole retry design leans on, so the mock implements it faithfully.
- An email whose local part starts with `flaky` returns `503` on its first two calls, then succeeds — demonstrates in-tick retry recovery.
- An email whose local part starts with `boom` always returns `503` — demonstrates a row exhausting `MAX_ATTEMPTS` and landing as `UPSTREAM_UNAVAILABLE`.
- An email whose local part starts with `slow` sleeps 2 seconds before succeeding — demonstrates the concurrency pool.

- [ ] **Step 1: Write the failing test**

Create `tests/mock/server.test.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMockEmployeeService } from '../../src/mock/server.js'

let app: FastifyInstance

beforeEach(async () => { app = await buildMockEmployeeService() })
afterEach(async () => { await app.close() })

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

  it('rejects an unsupported country with 400', async () => {
    const res = await create({ ...alice, country: 'XX' })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('XX')
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mock/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/mock/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'

/**
 * A stand-in for the real employee service, for end-to-end runs and manual testing.
 * Deliberately dependency-free relative to the rest of the application: it must be
 * possible to believe this is a different service written by a different team.
 *
 * Deterministic behaviours, so a Postman run can demonstrate every failure path:
 *   local part starts with "flaky" -> 503 twice, then succeeds
 *   local part starts with "boom"  -> 503 always
 *   local part starts with "slow"  -> succeeds after 2s
 *   unsupported country            -> 400
 *   repeated Idempotency-Key       -> 200 with the original employee, nothing created
 */

const SUPPORTED_COUNTRIES = new Set([
  'SG', 'VN', 'US', 'IN', 'GB', 'DE', 'AU', 'PH', 'ID', 'MY', 'JP', 'NL',
])

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
        return reply.code(200).send(employees.get(existingId))
      }
    }

    const localPart = employee.email.split('@')[0]?.toLowerCase() ?? ''

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

    if (!SUPPORTED_COUNTRIES.has(employee.country.toUpperCase())) {
      return reply.code(400).send({ message: `country '${employee.country}' is not supported` })
    }

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
const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? 4000)
  const app = await buildMockEmployeeService()
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[mock employee service] listening on http://localhost:${port}`)
}
```

Note the ordering inside the handler: the idempotency check comes **before** the failure injections, so a `flaky` row that eventually succeeded stays succeeded on any later retry — exactly how a real idempotent endpoint behaves.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mock/server.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify it runs standalone**

Run: `npm run mock` in one terminal, then in another:

```bash
curl -s -X POST http://localhost:4000/employees \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: alice@x.com' \
  -d '{"name":"Alice","email":"alice@x.com","startDate":"2026-03-01","country":"SG"}'
curl -s http://localhost:4000/employees
```

Expected: first call returns `201` with an id; `GET` lists one employee. Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add src/mock tests/mock
git commit -m "feat: mock employee service with idempotency and deterministic failure modes"
```

---

### Task 14: Application entrypoint, CSV generator and Postman collection

**Files:**
- Create: `src/index.ts`, `scripts/generate-csv.ts`, `postman/bulk-import.postman_collection.json`, `README.md`
- Test: `tests/index.smoke.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-13.
- Produces: a runnable service. No new exported types.

`src/index.ts` is the only place that constructs concrete implementations — the composition root. Everything below it depends on interfaces.

- [ ] **Step 1: Write the entrypoint**

Create `src/index.ts`:

```ts
import { HttpEmployeeClient } from './client/httpEmployeeClient.js'
import { loadConfig } from './config.js'
import { buildServer } from './http/server.js'
import { createBatchRunner } from './jobs/batchRunner.js'
import { startScheduler } from './jobs/scheduler.js'
import { connectMongo, disconnectMongo } from './store/connection.js'
import { MongooseImportRepository } from './store/mongooseRepository.js'

const config = loadConfig(process.env)

await connectMongo(config.mongoUri, config.mongoDb)

const repo = new MongooseImportRepository()
const client = new HttpEmployeeClient({ baseUrl: config.employeeServiceUrl })

const runner = createBatchRunner({
  repo,
  client,
  batchSize: config.batchSize,
  concurrency: config.upstreamConcurrency,
  maxAttempts: config.maxAttempts,
  staleClaimMs: config.staleClaimMs,
})

const task = startScheduler(config.cronSchedule, async () => {
  const stats = await runner.runBatch()
  if (stats.skipped || (stats.claimed === 0 && stats.reaped === 0)) return
  console.log('[cron]', JSON.stringify(stats))
})

const app = await buildServer({ repo, config })
await app.listen({ port: config.port, host: '0.0.0.0' })

console.log(`[api] listening on http://localhost:${config.port}`)
console.log(`[cron] schedule "${config.cronSchedule}", batch ${config.batchSize}, concurrency ${config.upstreamConcurrency}`)
console.log(`[upstream] ${config.employeeServiceUrl}`)

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal}`)
  task.stop()
  await app.close()
  await disconnectMongo()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
```

- [ ] **Step 2: Write the CSV generator**

Create `scripts/generate-csv.ts`:

```ts
/**
 * Generates a CSV for manual and end-to-end testing.
 *
 *   npm run gen:csv -- 200 fixtures/employees-200.csv
 *
 * Every tenth row is deliberately broken so a run exercises the failure paths:
 * a bad date, a duplicate email, a missing field, an unsupported country,
 * and emails that trigger the mock's flaky and boom behaviours.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const count = Number(process.argv[2] ?? 100)
const target = process.argv[3] ?? `fixtures/employees-${count}.csv`

const lines = ['name,email,start_date,country']

for (let i = 0; i < count; i++) {
  const n = i + 1
  switch (i % 10) {
    case 3:
      lines.push(`Bad Date ${n},baddate${n}@x.com,31/02/2026,SG`)
      break
    case 5:
      lines.push(`Dupe ${n},duplicate@x.com,01/03/2026,SG`)
      break
    case 7:
      lines.push(`No Country ${n},nocountry${n}@x.com,01/03/2026,`)
      break
    case 8:
      lines.push(`Bad Country ${n},badcountry${n}@x.com,01/03/2026,ZZ`)
      break
    case 9:
      lines.push(`Flaky ${n},flaky${n}@x.com,01/03/2026,VN`)
      break
    default:
      lines.push(`Person ${n},person${n}@x.com,0${(i % 9) + 1}/03/2026,SG`)
  }
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
console.log(`wrote ${count} rows to ${target}`)
```

- [ ] **Step 3: Write the smoke test**

Create `tests/index.smoke.test.ts`. It proves the pieces compose end to end in-process — upload, tick, status — without binding a port:

```ts
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
```

- [ ] **Step 4: Run the smoke test**

Run: `npx vitest run tests/index.smoke.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the Postman collection**

Create `postman/bulk-import.postman_collection.json`:

```json
{
  "info": {
    "name": "Bulk Employee Import",
    "description": "Upload a CSV, poll the import status, inspect what the mock employee service received.",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:3000" },
    { "key": "mockUrl", "value": "http://localhost:4000" },
    { "key": "importId", "value": "" }
  ],
  "item": [
    {
      "name": "1. Reset mock employee service",
      "request": {
        "method": "DELETE",
        "url": { "raw": "{{mockUrl}}/employees", "host": ["{{mockUrl}}"], "path": ["employees"] }
      }
    },
    {
      "name": "2. Upload CSV",
      "event": [
        {
          "listen": "test",
          "script": {
            "type": "text/javascript",
            "exec": [
              "pm.test('accepted', () => pm.response.to.have.status(202));",
              "const body = pm.response.json();",
              "pm.collectionVariables.set('importId', body.importId);",
              "console.log('importId', body.importId, 'accepted', body.accepted, 'rejected', body.rejected);"
            ]
          }
        }
      ],
      "request": {
        "method": "POST",
        "url": { "raw": "{{baseUrl}}/imports", "host": ["{{baseUrl}}"], "path": ["imports"] },
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "file", "type": "file", "src": "fixtures/employees-200.csv", "description": "generate with: npm run gen:csv -- 200 fixtures/employees-200.csv" }
          ]
        }
      }
    },
    {
      "name": "3. Poll import status",
      "event": [
        {
          "listen": "test",
          "script": {
            "type": "text/javascript",
            "exec": [
              "pm.test('ok', () => pm.response.to.have.status(200));",
              "const b = pm.response.json();",
              "console.log(b.status, JSON.stringify(b.counts));"
            ]
          }
        }
      ],
      "request": {
        "method": "GET",
        "url": {
          "raw": "{{baseUrl}}/imports/{{importId}}/status",
          "host": ["{{baseUrl}}"],
          "path": ["imports", "{{importId}}", "status"]
        }
      }
    },
    {
      "name": "4. List employees created by the mock",
      "request": {
        "method": "GET",
        "url": { "raw": "{{mockUrl}}/employees", "host": ["{{mockUrl}}"], "path": ["employees"] }
      }
    },
    {
      "name": "5. Upload a file with a bad header (expect 400)",
      "request": {
        "method": "POST",
        "url": { "raw": "{{baseUrl}}/imports", "host": ["{{baseUrl}}"], "path": ["imports"] },
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "file", "type": "file", "src": "fixtures/bad-header.csv" }
          ]
        }
      }
    },
    {
      "name": "6. Status of an unknown import (expect 404)",
      "request": {
        "method": "GET",
        "url": {
          "raw": "{{baseUrl}}/imports/66c1f0a3e4b0a1c2d3e4f5a6/status",
          "host": ["{{baseUrl}}"],
          "path": ["imports", "66c1f0a3e4b0a1c2d3e4f5a6", "status"]
        }
      }
    },
    {
      "name": "7. Health",
      "request": {
        "method": "GET",
        "url": { "raw": "{{baseUrl}}/health", "host": ["{{baseUrl}}"], "path": ["health"] }
      }
    }
  ]
}
```

- [ ] **Step 6: Write the README**

Create `README.md`:

````markdown
# Bulk Employee Import

Accepts a CSV of employees, validates it, and creates each one in the existing
employee service via `POST /employees`. Upload is synchronous; dispatch happens on a
cron-driven batch runner so a file with thousands of rows does not hold an HTTP
connection open.

- **Spec:** `docs/superpowers/specs/2026-08-19-bulk-employee-import-design.md`
- **Plan:** `docs/superpowers/plans/2026-08-19-bulk-employee-import.md`

## Running it

Needs MongoDB on `localhost:27017`.

```bash
npm install
npm run mock     # terminal 1 — stand-in employee service on :4000
npm start        # terminal 2 — this service on :3000
```

## Trying it

```bash
npm run gen:csv -- 200 fixtures/employees-200.csv

curl -s -X POST http://localhost:3000/imports -F file=@fixtures/employees-200.csv | jq
curl -s http://localhost:3000/imports/<importId>/status | jq
curl -s http://localhost:4000/employees | jq '.employees | length'
```

The generated file deliberately includes broken rows so a run exercises every failure
path: a bad date, a duplicate email, a missing field, an unsupported country, and
`flaky` emails that make the mock return `503` twice before succeeding.

`postman/bulk-import.postman_collection.json` walks the same flow.

## API

| Route | Purpose |
|---|---|
| `POST /imports` | multipart CSV upload, returns `202` with an `importId` and any rows that failed validation |
| `GET /imports/:id/status` | live counts and accumulated failures |
| `GET /health` | liveness |

CSV columns, in this order: `name,email,start_date,country`. Dates are `DD/MM/YYYY`.

## Tests

```bash
npm test
```

Vitest throughout. Store tests run against a real in-memory MongoDB
(`mongodb-memory-server`) — the atomic claim, the partial unique index, and the
stale-claim reaper are exactly the things a mocked driver would let us get wrong.

## Configuration

See `.env.example`. The dials that matter: `BATCH_SIZE` (rows per tick),
`CRON_SCHEDULE`, `UPSTREAM_CONCURRENCY`, `MAX_ATTEMPTS`.
````

- [ ] **Step 7: Generate the fixtures the Postman collection references**

```bash
npm run gen:csv -- 200 fixtures/employees-200.csv
printf 'wrong,header,names,here\nA,B,C,D\n' > fixtures/bad-header.csv
```

Expected: both files exist under `fixtures/`.

- [ ] **Step 8: Verify the whole thing typechecks and every test passes**

Run: `npm run typecheck && npm test`
Expected: no type errors; every test in every file passes.

- [ ] **Step 9: Verify the service actually boots and does the job**

In three terminals:

```bash
npm run mock                                                    # terminal 1
npm start                                                       # terminal 2
curl -s -X POST http://localhost:3000/imports \
  -F file=@fixtures/employees-200.csv | jq '{importId, accepted, rejected}'
```

Then, watching terminal 2 for `[cron]` lines, poll until terminal:

```bash
curl -s http://localhost:3000/imports/<importId>/status | jq '{status, counts}'
curl -s http://localhost:4000/employees | jq '.employees | length'
```

Expected: status reaches `COMPLETED_WITH_ERRORS` (the generated file contains
deliberately broken rows), succeeded plus failed equals 200, and the mock holds exactly
the succeeded count.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts scripts postman README.md tests/index.smoke.test.ts fixtures/.gitkeep
git commit -m "feat: composition root, CSV generator, Postman collection and README"
```

---

## Appendix: file structure

| File | Responsibility |
|---|---|
| `src/config.ts` | env → typed `Config`, the only place defaults live |
| `src/csv/parse.ts` | bytes → `RawRow[]`, header check. Judges no content. |
| `src/domain/reasons.ts` | the failure-code vocabulary |
| `src/domain/validate.ts` | one row → draft or failure |
| `src/domain/dedupe.ts` | in-file email dedupe |
| `src/domain/upload.ts` | orchestrates parse → validate → dedupe → persist |
| `src/store/models/*.ts` | Mongoose schemas and indexes |
| `src/store/connection.ts` | connect, `syncIndexes`, disconnect |
| `src/store/importRepository.ts` | the persistence interface everything else depends on |
| `src/store/mongooseRepository.ts` | the only Mongo-aware implementation |
| `src/client/pool.ts` | bounded concurrency |
| `src/client/employeeClient.ts` | the upstream interface |
| `src/client/httpEmployeeClient.ts` | retry, backoff, idempotency key |
| `src/jobs/batchRunner.ts` | reap → claim → dispatch → record → settle |
| `src/jobs/scheduler.ts` | node-cron wiring only |
| `src/http/routes.ts` | HTTP ↔ domain translation, error → status mapping |
| `src/http/server.ts` | Fastify assembly |
| `src/mock/server.ts` | stand-in employee service, no application imports |
| `src/index.ts` | composition root — the only file that constructs concrete classes |
