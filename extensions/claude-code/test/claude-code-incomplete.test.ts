import { expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { incompleteResponseError } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { normalizeError } from '@earendil-works/pi-claude-code/src/stream.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — a response that ends without
// a result and without stderr must be retryable by pi-ai. Drop with the matching pnpm patch when upstream fixes this.
// The stream stores normalizeError(thrown) as errorMessage; the retry check reads only these two fields.
const failed = (error: Error) =>
  ({
    stopReason: 'error',
    errorMessage: normalizeError(error),
  }) as AssistantMessage

it('retries a Claude Code stream that ends without a result and gives no reason', () => {
  const message = failed(incompleteResponseError(''))
  expect(message.errorMessage).toMatch(/^Incomplete Claude Code response: stream ended without/)
  expect(isRetryableAssistantError(message)).toBe(true)
})

it('lets Claude Code stderr decide whether an incomplete response retries', () => {
  expect(
    isRetryableAssistantError(failed(incompleteResponseError('Error: quota exceeded\n'))),
  ).toBe(false)
  expect(isRetryableAssistantError(failed(incompleteResponseError('Invalid model name')))).toBe(
    false,
  )
  expect(
    isRetryableAssistantError(failed(incompleteResponseError('API Error: 529 overloaded'))),
  ).toBe(true)
})
