import { Schema, model, type InferSchemaType } from 'mongoose'

export const IMPORT_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
] as const
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
