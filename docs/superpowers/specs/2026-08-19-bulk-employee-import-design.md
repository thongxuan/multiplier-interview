# Bulk Employee Import — Design

**Date:** 2026-08-19
**Status:** Approved for implementation

## Problem

Customers send employee data as spreadsheets. Ops copies rows into Multiplier one at a
time. We want the customer to hand us a file and have every employee created.

Employees are created through an existing, separate **employee service** exposing
`POST /employees`, which creates **one employee per call**. We call it over the network.
We do not write to its database.

## Goal

A standalone HTTP service that accepts a CSV upload, validates it, and creates every
valid row in the employee service — reporting, per row, exactly what failed and why.

## Non-goals

Deliberately excluded from this slice:

- Any UI. Postman drives the endpoints.
- Per-customer column mapping. One fixed column set (see [CSV contract](#csv-contract)).
- File-level duplicate detection (hashing an uploaded file to reject a re-upload).
- Authentication and authorization.
- Multi-tenancy. No customer/tenant dimension on imports.
- Updating or deleting employees. Creation only.

---

## Architecture

Upload and dispatch are decoupled. A file with several thousand rows means several
thousand network calls to the employee service; nobody holds an HTTP connection open for
that. So:

- **Upload is synchronous.** Parse, validate, dedupe, and persist every row — then return
  `202` immediately. Parsing 5,000 rows takes single-digit milliseconds, so a malformed
  file still fails fast and loudly at upload time.
- **Dispatch is asynchronous.** A cron job claims batches of pending rows and calls the
  employee service, recording each outcome.
- **A probe endpoint** reports progress and accumulated failures so ops can poll.

```
              ┌──────────────┐
  CSV ──────► │ POST /imports│──► validate ──► dedupe ──► MongoDB (imports, import_rows)
              └──────────────┘                                     │
                     │ 202 + importId                              │
                     ▼                                             ▼
              ┌──────────────────┐                    ┌─────────────────────────┐
  poll ─────► │ GET /imports/:id │◄── aggregate ───── │ node-cron, every 10s    │
              │      /status     │                    │  reap → claim → dispatch│
              └──────────────────┘                    └────────────┬────────────┘
                                                                   │ pool(5)
                                                                   ▼
                                                       ┌───────────────────────┐
                                                       │ employee service      │
                                                       │ POST /employees       │
                                                       └───────────────────────┘
```

### Stack

Node.js, TypeScript, Fastify, Mongoose, `node-cron`, `csv-parse`, Vitest,
`mongodb-memory-server`.

---

## CSV contract

Header row required, exactly these four columns:

```csv
name,email,start_date,country
Alice Tan,alice@acme.com,01/03/2026,SG
```

| Column | Rule |
|---|---|
| `name` | non-empty after trim |
| `email` | non-empty, matches a pragmatic email regex, normalized to lowercase+trim for dedupe |
| `start_date` | strict `DD/MM/YYYY`, must be a real calendar date, normalized to ISO `YYYY-MM-DD` |
| `country` | non-empty after trim |

Wrong or missing headers reject the whole file with `400` — nothing is stored, nothing is
dispatched.

**Country is not validated locally.** The employee service is the authority on which
countries it supports. A duplicate allowlist here would drift out of sync with it, so an
unsupported country surfaces as `UPSTREAM_REJECTED` carrying the employee service's own
message.

### Limits

| Limit | Value | Configurable via |
|---|---|---|
| Max file size | 50 MB | `MAX_FILE_BYTES` |
| Max rows | 50,000 | `MAX_ROWS` |

Exceeding either returns `413` before parsing.

---

## API

### `POST /imports`

`multipart/form-data`, file in the field `file`.

Parses, validates, dedupes, and stores every row. Returns immediately.

**`202 Accepted`**

```jsonc
{
  "importId": "66c1f0a3e4b0a1c2d3e4f5a6",
  "total": 5000,
  "accepted": 4996,          // stored PENDING, queued for dispatch
  "rejected": 4,             // stored FAILED, never dispatched
  "failures": [
    { "line": 41, "email": "a@x.com", "reason": "INVALID_DATE",
      "detail": "start_date '31/02/2026' is not a real date" }
  ],
  "statusUrl": "/imports/66c1f0a3e4b0a1c2d3e4f5a6/status"
}
```

**Errors**

| Status | Cause |
|---|---|
| `400` | missing file field, empty file, wrong/missing headers, unparseable CSV |
| `413` | over `MAX_FILE_BYTES` or `MAX_ROWS` |

### `GET /imports/:id/status`

**`200 OK`**

```jsonc
{
  "importId": "66c1f0a3e4b0a1c2d3e4f5a6",
  "status": "PROCESSING",
  "total": 5000,
  "counts": { "pending": 3200, "inFlight": 50, "succeeded": 1746, "failed": 4 },
  "failures": [ /* up to 100, sorted by line */ ],
  "failuresTruncated": false,
  "createdAt": "2026-08-19T10:00:00.000Z",
  "completedAt": null
}
```

`404` for an unknown id.

Failures accumulate as they happen, so ops sees problems mid-run rather than discovering
them at the end. The inline array is capped at 100 with `failuresTruncated: true` past
that — a 5,000-row disaster must not return a 5,000-element blob to a polling client.

**Import status values**

| Status | Meaning |
|---|---|
| `QUEUED` | rows stored, no batch claimed yet |
| `PROCESSING` | at least one row dispatched, work remains |
| `COMPLETED` | no pending/in-flight rows, zero failures |
| `COMPLETED_WITH_ERRORS` | no pending/in-flight rows, at least one failure |

---

## Failure reporting

`line` is the **spreadsheet line number**: header is line 1, the first employee is line 2.
Ops opens the file and jumps straight to the line. An array index would force arithmetic.

`reason` is a closed set of machine-readable codes; `detail` carries the human string.

| Reason | Meaning | Terminal |
|---|---|---|
| `MALFORMED_ROW` | wrong number of columns | yes |
| `MISSING_FIELD` | a required field is blank | yes |
| `INVALID_EMAIL` | email fails format check | yes |
| `INVALID_DATE` | not a real `DD/MM/YYYY` date | yes |
| `DUPLICATE_IN_FILE` | an earlier row in this file has the same email | yes |
| `UPSTREAM_REJECTED` | employee service returned 4xx | yes |
| `UPSTREAM_UNAVAILABLE` | 5xx/network, retries exhausted | yes |

The first five are detected at upload; the row is stored already `FAILED` and never
dispatched. One code path, one place the status endpoint reads failures from.

### Deduplication

Within a single file, emails are deduped on the normalized (lowercased, trimmed) value.
**The first occurrence wins**; every later occurrence is stored `FAILED` with
`DUPLICATE_IN_FILE` and its own line number, so ops can see which duplicate was dropped.

Dedupe is scoped to the file. Whether an email already exists in the employee service is
that service's ruling, surfaced as `UPSTREAM_REJECTED`.

---

## Employee service client

`EmployeeClient` is an interface. Two implementations:

- `HttpEmployeeClient` — the real thing.
- `mock/server.ts` — a standalone fake employee service, a real HTTP process, so the
  Postman end-to-end run works without the real service.

Unit tests inject an in-memory fake rather than either.

### Request

```http
POST /employees
Content-Type: application/json
Idempotency-Key: alice@acme.com

{ "name": "Alice Tan", "email": "alice@acme.com",
  "startDate": "2026-03-01", "country": "SG" }
```

### Retry policy

| Response | Action |
|---|---|
| 2xx | success |
| 4xx | terminal — `UPSTREAM_REJECTED`, never retried |
| 429, 5xx, network error, timeout | retry: 200ms → 400ms → 800ms, plus jitter, 3 attempts |

Concurrency is capped at **5** in-flight requests (`UPSTREAM_CONCURRENCY`).

Retrying a validation rejection is pointless, so 4xx is terminal on the first response.

### Assumptions requiring confirmation

Two contract guesses, isolated so correcting them is cheap:

1. **The employee service honors `Idempotency-Key`.** This is what makes retries and
   reaped claims safe. If it does not, a retry after a timeout can double-create, and the
   fix is a `GET /employees?email=` pre-check before each dispatch.
2. **Its payload is `{ name, email, startDate, country }` with an ISO date.** The mapping
   lives in one function, so a correction is a one-line change.

---

## Data model — Mongoose

`MONGODB_URI` defaults to `mongodb://localhost:27017`, database `bulk_import`.

### `Import`

```ts
{ _id, filename, total,
  status: 'QUEUED'|'PROCESSING'|'COMPLETED'|'COMPLETED_WITH_ERRORS',
  createdAt, updatedAt, completedAt }
```

### `ImportRow`

```ts
{ _id, importId, line,
  status: 'PENDING'|'IN_FLIGHT'|'SUCCEEDED'|'FAILED',
  payload: { name, email, startDate, country },
  emailNormalized,
  attempts, claimId, claimedAt,
  reason, detail,
  createdAt, updatedAt }
```

### Indexes

```
ImportRow  { importId: 1, status: 1 }             claiming and counts
           { claimId: 1 }                         batch readback
           { importId: 1, emailNormalized: 1 }    unique,
                                                  partialFilterExpression:
                                                    { status: { $ne: 'FAILED' } }
Import     { status: 1, createdAt: 1 }            oldest unfinished import
```

The unique index is a safety net under the application-level dedupe, not a replacement:
duplicates must be *reported* with a line number, not surfaced as a driver exception. It
is partial on non-`FAILED` so a rejected duplicate can still be stored for reporting.

### Mongoose configuration

- **`autoIndex: false` plus an explicit `syncIndexes()` at startup.** The default builds
  indexes lazily in the background — a surprise in production and a race in tests. The
  partial unique index must exist before the first insert.
- **`.lean()` on the batch read.** 50 documents per tick, read-only; change tracking is
  unused overhead.

### Repository boundary

`ImportRepository` is an interface with a `MongooseImportRepository` implementation. The
batch runner and routes are tested against a fake with no database at all; Mongo-backed
tests cover only the queries needing real semantics — the claim guard, the partial unique
index, the reaper, the counts aggregation.

---

## Upload path

1. Reject oversized uploads before parsing (`413`).
2. Parse CSV — strip BOM, tolerate CRLF, require the exact header. Bad header → `400`,
   nothing stored.
3. Validate each row; build either a draft or a failure carrying the line number.
4. Dedupe drafts on `emailNormalized`, first-wins.
5. `insertMany` rows in chunks of 1,000 with `ordered: false`. Valid rows `PENDING`,
   invalid rows `FAILED` with their reason.
6. **Write the `Import` document last**, after every row is inserted, so the cron can
   never claim a half-inserted import.
7. Return `202`.

50,000 rows lands in a couple of seconds — acceptable inside a request that returns `202`.

---

## Dispatch — the cron tick

`node-cron`, six-field expression `*/10 * * * * *` — every 10 seconds
(`CRON_SCHEDULE`).

**`runBatch()` is a plain async function; `node-cron` only calls it on a timer.** Tests
invoke `runBatch()` directly and assert on state transitions — no timers, no sleeps, no
flakiness. Testing a cron *schedule* is worth almost nothing; testing the function it
invokes is the point.

### Tick sequence

**1. Overlap guard.** A module-level `isRunning` flag; if the previous tick is still
working, return immediately. Without it a slow batch gets a second worker dispatching the
same rows, leaving only the idempotency key between us and duplicate employees.

**2. Reap stale claims.**

```ts
ImportRow.updateMany(
  { status: 'IN_FLIGHT', claimedAt: { $lt: staleBefore } },
  { $set: { status: 'PENDING', claimId: null }, $inc: { attempts: 1 } })
```

A process that dies mid-batch leaves rows wedged in `IN_FLIGHT` forever. The reaper
returns them after `STALE_CLAIM_MS` (default 5 minutes). `attempts` still increments, so a
row that repeatedly kills the process eventually terminates rather than looping. Reclaiming
is safe because `Idempotency-Key: <email>` means a row reaped *after* its upstream call
actually succeeded will not double-create.

**3. Claim a batch atomically.** Up to `BATCH_SIZE` (default 50) rows from the oldest
unfinished import:

```ts
const claimId = new Types.ObjectId()
const ids = await ImportRow.find({ importId, status: 'PENDING' })
                           .select('_id').limit(BATCH_SIZE).lean()
await ImportRow.updateMany(
  { _id: { $in: ids.map(r => r._id) }, status: 'PENDING' },   // ← the guard
  { $set: { status: 'IN_FLIGHT', claimId, claimedAt: new Date() } })
const batch = await ImportRow.find({ claimId }).lean()        // what we actually got
```

The `status: 'PENDING'` filter on the update is what makes this safe. A competing worker
that read the same ids matches nothing, and each worker processes only rows carrying its
own `claimId`. This is correct even without the `isRunning` guard, which remains as the
cheap first line of defence.

**4. Dispatch** through the 5-slot pool with `Idempotency-Key`.

**5. Record outcomes.**

| Result | Row becomes |
|---|---|
| 2xx | `SUCCEEDED` |
| 4xx | `FAILED`, `UPSTREAM_REJECTED` |
| 5xx/network, in-tick retries exhausted, `attempts + 1 < MAX_ATTEMPTS` | `PENDING`, `attempts` incremented — next tick retries |
| same, but `attempts + 1 >= MAX_ATTEMPTS` | `FAILED`, `UPSTREAM_UNAVAILABLE` |

`MAX_ATTEMPTS` defaults to 3.

**6. Settle the import.** When it has zero `PENDING` and zero `IN_FLIGHT`, stamp
`COMPLETED` or `COMPLETED_WITH_ERRORS` and set `completedAt`.

### Throughput

50 rows per 10-second tick ≈ 5,000 rows in roughly 17 minutes. Both numbers are
configuration, so this is a dial rather than a constant.

### Counts

A single aggregation per poll, covered by `{ importId, status }`:

```ts
ImportRow.aggregate([
  { $match: { importId } },
  { $group: { _id: '$status', n: { $sum: 1 } } },
])
```

No denormalized counters. `$inc` counters would be faster but drift the moment a write
path forgets one, and drifted counts on a status endpoint are worse than a slower query.
If polling becomes hot, that is the optimization — not the starting point.

---

## Module layout

```
src/
  config.ts                  env parsing, all tunables
  http/
    server.ts                Fastify instance, multipart registration
    routes.ts                POST /imports, GET /imports/:id/status — no logic
  csv/
    parse.ts                 bytes → RawRow[] { line, cells }, header check
  domain/
    validate.ts              RawRow → Ok<EmployeeDraft> | Err<RowFailure>
    dedupe.ts                drafts → { kept, duplicates }
    upload.ts                orchestrates parse → validate → dedupe → persist
    reasons.ts               the failure-code enum
  store/
    importRepository.ts      interface
    mongooseRepository.ts    implementation
    models/import.ts
    models/importRow.ts
  client/
    employeeClient.ts        interface
    httpEmployeeClient.ts    real client: retry, backoff, idempotency header
    pool.ts                  bounded concurrency
  jobs/
    batchRunner.ts           runBatch() — reap, claim, dispatch, record, settle
    scheduler.ts             node-cron wrapper, ~15 lines
  mock/
    server.ts                standalone fake employee service for Postman
```

Every module has one purpose and a defined interface. The orchestrators (`upload.ts`,
`batchRunner.ts`) are the only modules aware of more than their immediate neighbours.

---

## Configuration

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `MONGODB_URI` | `mongodb://localhost:27017` |
| `MONGODB_DB` | `bulk_import` |
| `EMPLOYEE_SERVICE_URL` | `http://localhost:4000` |
| `CRON_SCHEDULE` | `*/10 * * * * *` |
| `BATCH_SIZE` | `50` |
| `UPSTREAM_CONCURRENCY` | `5` |
| `MAX_ATTEMPTS` | `3` |
| `STALE_CLAIM_MS` | `300000` |
| `MAX_ROWS` | `50000` |
| `MAX_FILE_BYTES` | `52428800` |

---

## Testing

Vitest. `mongodb-memory-server` for Mongo-backed tests, started once per test file, database
dropped between tests — real Mongo semantics, because the claim query, the partial unique
index, and the reaper are precisely what a mocked driver would let us get wrong.

**Done means every test below passes.** End-to-end verification is a separate Postman run.

### `csv/parse`
quoted commas · BOM · CRLF · trailing blank line · wrong column count → `MALFORMED_ROW` ·
missing header → file-level rejection

### `domain/validate`
one test per reason code · `31/02/2026` rejected (not a real date) · `1/1/2026` rejected
(not `DD/MM/YYYY`) · `2026-01-01` rejected (wrong format) · `01/03/2026` → `2026-03-01`

### `domain/dedupe`
`Alice@X.com` and `alice@x.com ` collide · the **second** is the failure · the failure
carries the second row's line number

### `client/httpEmployeeClient`
retries 429 then succeeds · does not retry 400 · sends `Idempotency-Key` · exhausts to
`UPSTREAM_UNAVAILABLE` (fake timers) · pool never exceeds 5 in flight

### `jobs/batchRunner`
claims no more than `BATCH_SIZE` · marks succeeded and failed correctly · a 503 row returns
to `PENDING` with `attempts` incremented · `attempts` reaching `MAX_ATTEMPTS` terminates as
`UPSTREAM_UNAVAILABLE` · a 400 never returns to `PENDING` · the final row settles the import
with the right terminal status · a second `runBatch()` during an in-flight tick claims
nothing

### `store` (Mongo-backed)
concurrent claims never take the same row · reaper returns stale `IN_FLIGHT` and increments
attempts · reaper ignores fresh claims · unique index rejects a duplicate that bypasses app
dedupe · counts aggregation matches actual row states

### `http/routes`
`202` with inline validation failures · `GET /status` reflects mid-run state · unknown id →
`404` · `failuresTruncated` past 100 failures · bad header → `400` · oversized → `413`

---

## Known limitations

Accepted for this slice, recorded so they are not mistaken for oversights:

- **No cross-file dedupe.** Uploading the same file twice re-sends every row. The
  idempotency key prevents duplicate employees if the employee service honors it; the second
  import will simply report rows as already existing.
- **Single-import serial processing.** The tick drains the oldest unfinished import before
  starting the next. A large import delays a small one queued behind it.
- **No cancellation.** An import in progress cannot be stopped.
- **No auth.** Anyone who can reach the service can upload.
- **Reaper timeout is fixed.** A genuinely slow batch exceeding `STALE_CLAIM_MS` gets reaped
  while still running, relying on the idempotency key to stay correct.
