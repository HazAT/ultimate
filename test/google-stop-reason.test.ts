import type { AssistantMessage } from '@earendil-works/pi-ai'
import { mapStopReason } from '@earendil-works/pi-ai/api/google-shared'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { expect, it } from 'vitest'

function failedAssistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'google-generative-ai',
    provider: 'google',
    model: 'gemini-test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: 0,
    ...overrides,
  }
}

it('maps MALFORMED_RESPONSE and unknown Google finish reasons to error', () => {
  type FinishReason = Parameters<typeof mapStopReason>[0]
  expect(mapStopReason('MALFORMED_RESPONSE' as FinishReason)).toBe('error')
  expect(mapStopReason('SOME_FUTURE_FINISH_REASON' as FinishReason)).toBe('error')
})

it('treats MALFORMED_RESPONSE as retryable', () => {
  expect(
    isRetryableAssistantError(
      failedAssistant({
        rawStopReason: 'MALFORMED_RESPONSE',
        errorMessage: 'Provider stopped with: MALFORMED_RESPONSE',
      }),
    ),
  ).toBe(true)
  expect(
    isRetryableAssistantError(
      failedAssistant({ errorMessage: 'Unhandled stop reason: MALFORMED_RESPONSE' }),
    ),
  ).toBe(true)
  expect(isRetryableAssistantError(failedAssistant({ rawStopReason: 'MALFORMED_RESPONSE' }))).toBe(
    true,
  )
})
