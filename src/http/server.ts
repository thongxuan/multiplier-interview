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
