import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { CsvFormatError } from '../csv/parse.js'
import { TooManyRowsError, processUpload } from '../domain/upload.js'
import { MAX_INLINE_FAILURES, type ImportRepository } from '../store/importRepository.js'

export interface RouteDeps {
  repo: ImportRepository
  config: Config
}

function isFileTooLarge(err: unknown): boolean {
  return (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE'
}

/** Translation only: HTTP in, domain out, errors mapped to status codes. No logic here. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }))

  app.post('/imports', async (request, reply) => {
    const tooLarge = () =>
      reply.code(413).send({
        reason: 'TOO_LARGE',
        detail: `file exceeds ${deps.config.maxFileBytes} bytes`,
      })

    let buffer: Buffer
    let filename: string
    try {
      const file = await request.file()
      if (!file) {
        return reply
          .code(400)
          .send({ reason: 'MISSING_FILE', detail: 'expected a file field named "file"' })
      }
      filename = file.filename
      buffer = await file.toBuffer()
    } catch (err) {
      if (isFileTooLarge(err)) return tooLarge()
      throw err
    }

    try {
      const result = await processUpload(buffer, filename, deps.repo, deps.config.maxRows)
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
      return reply
        .code(404)
        .send({ reason: 'NOT_FOUND', detail: `no import with id ${request.params.id}` })
    }
    return reply.code(200).send(summary)
  })
}
