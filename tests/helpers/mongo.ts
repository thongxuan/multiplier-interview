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
