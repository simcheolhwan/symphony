import { z } from "zod"

import { WORKFLOW_NAMES } from "./registry.ts"

const operationTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("instance"),
    alias: z.string(),
    workflow: z.enum(WORKFLOW_NAMES),
  }),
  z.object({ type: z.literal("notifier") }),
])

export type OperationTarget = z.infer<typeof operationTargetSchema>

export const OPERATION_OUTCOMES = ["started", "restarted", "stopped", "unchanged"] as const
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number]

const operationResultSchema = z.object({
  target: operationTargetSchema,
  outcome: z.enum(OPERATION_OUTCOMES),
})

export type OperationResult = z.infer<typeof operationResultSchema>

export const operationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.enum(["start", "restart", "stop"]),
  results: z.array(operationResultSchema),
})

export type OperationCommand = z.infer<typeof operationResponseSchema>["command"]
export type OperationResponse = z.infer<typeof operationResponseSchema>

export const toOperationResponse = (
  command: OperationCommand,
  results: OperationResult[],
): OperationResponse => operationResponseSchema.parse({ schemaVersion: 1, command, results })

export const serializeOperationResponse = (
  command: OperationCommand,
  results: OperationResult[],
): string => JSON.stringify(toOperationResponse(command, results))

export const OPERATION_STAGES = ["validate", "delete", "start", "health-check"] as const
export type OperationStage = (typeof OPERATION_STAGES)[number]

export class OperationError extends Error {
  readonly stage: OperationStage
  readonly target: OperationTarget

  constructor(stage: OperationStage, target: OperationTarget, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "OperationError"
    this.stage = stage
    this.target = target
  }
}

export const errorResponseSchema = z.object({
  schemaVersion: z.literal(1),
  error: z.object({
    message: z.string(),
    stage: z.enum(OPERATION_STAGES).optional(),
    target: operationTargetSchema.optional(),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

export const toErrorResponse = (error: unknown): ErrorResponse => {
  const message = error instanceof Error ? error.message : String(error)
  return errorResponseSchema.parse({
    schemaVersion: 1,
    error:
      error instanceof OperationError
        ? { message, stage: error.stage, target: error.target }
        : { message },
  })
}

export const serializeErrorResponse = (error: unknown): string =>
  JSON.stringify(toErrorResponse(error))
