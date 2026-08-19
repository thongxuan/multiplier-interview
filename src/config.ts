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
    employeeServiceUrl: str(env, 'EMPLOYEE_SERVICE_URL', 'http://localhost:8888'),
    cronSchedule: str(env, 'CRON_SCHEDULE', '*/10 * * * * *'),
    batchSize: num(env, 'BATCH_SIZE', 50),
    upstreamConcurrency: num(env, 'UPSTREAM_CONCURRENCY', 5),
    maxAttempts: num(env, 'MAX_ATTEMPTS', 3),
    staleClaimMs: num(env, 'STALE_CLAIM_MS', 300_000),
    maxRows: num(env, 'MAX_ROWS', 50_000),
    maxFileBytes: num(env, 'MAX_FILE_BYTES', 52_428_800),
  }
}
