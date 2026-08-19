import mongoose from 'mongoose'
import { ImportModel } from './models/import.js'
import { ImportRowModel } from './models/importRow.js'

export async function connectMongo(uri: string, dbName: string): Promise<void> {
  await mongoose.connect(uri, { dbName, autoIndex: false })
  await syncIndexes()
}

/**
 * Builds every declared index. Must run before the first insert: Mongoose's default
 * autoIndex builds them lazily in the background, which races the first write and
 * would let a duplicate slip past the partial unique index.
 */
export async function syncIndexes(): Promise<void> {
  await ImportModel.syncIndexes()
  await ImportRowModel.syncIndexes()
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect()
}
