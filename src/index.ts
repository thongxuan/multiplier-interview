import { HttpEmployeeClient } from './client/httpEmployeeClient.js'
import { loadConfig } from './config.js'
import { buildServer } from './http/server.js'
import { createBatchRunner } from './jobs/batchRunner.js'
import { startScheduler } from './jobs/scheduler.js'
import { connectMongo, disconnectMongo } from './store/connection.js'
import { MongooseImportRepository } from './store/mongooseRepository.js'

// Composition root: the only file that constructs concrete implementations.
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
console.log(
  `[cron] schedule "${config.cronSchedule}", batch ${config.batchSize}, concurrency ${config.upstreamConcurrency}`,
)
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
