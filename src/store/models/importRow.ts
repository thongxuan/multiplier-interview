import { Schema, model, type InferSchemaType, type Types } from 'mongoose'

export const ROW_STATUSES = ['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED'] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

const ImportRowSchema = new Schema(
  {
    importId: { type: Schema.Types.ObjectId, ref: 'Import', required: true },
    line: { type: Number, required: true },
    status: { type: String, enum: ROW_STATUSES, default: 'PENDING', required: true },
    // Not schema-required: content validation belongs to the domain, and a row stored
    // already FAILED (bad date, malformed) legitimately has an empty payload.
    payload: {
      name: { type: String, default: '' },
      email: { type: String, default: '' },
      startDate: { type: String, default: '' },
      country: { type: String, default: '' },
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
// Safety net beneath the application-level dedupe. Scoped to the non-FAILED statuses so a
// row already rejected as a duplicate can still be stored for reporting.
// MongoDB does not accept $ne in a partialFilterExpression, hence the explicit $in.
export const LIVE_ROW_STATUSES = ['PENDING', 'IN_FLIGHT', 'SUCCEEDED'] as const

ImportRowSchema.index(
  { importId: 1, emailNormalized: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [...LIVE_ROW_STATUSES] } } },
)

export type ImportRowDoc = InferSchemaType<typeof ImportRowSchema> & { _id: Types.ObjectId }
export const ImportRowModel = model('ImportRow', ImportRowSchema)
