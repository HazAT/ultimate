import type { JsonValue } from '@earendil-works/chord/json'

export const MAX_CHANGES = 50
export const MAX_VALUE_BYTES = 2048
export const MAX_NAME = 64
export const MAX_LABEL = 200

export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength

export const bounded = (value: unknown): JsonValue =>
  jsonBytes(value) > MAX_VALUE_BYTES ? '[too large]' : (value as JsonValue)
