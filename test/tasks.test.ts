import type { ConversationId, ReportTask, TaskId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { createHarnessSettings, reportMessage } from '../server/harness.ts'
import { SettingsManager } from '@earendil-works/pi-coding-agent'

it('a report notice names what failed', () => {
  const task = {
    id: 12 as TaskId,
    kind: 'pi.generation',
    conversationId: 4 as ConversationId,
  } as ReportTask
  expect(
    reportMessage({
      kind: 'task_faulted',
      task,
      extension: 'messages',
      reason: 'restart_limit',
      error: new Error('boom'),
    }),
  ).toBe(
    'task faulted (restart limit): task #12 (pi.generation) in #4, extension messages. Error: boom',
  )
  expect(reportMessage({ kind: 'host_error', callback: 'models', error: new Error('x') })).toBe(
    'host error: host callback models. Error: x',
  )
  expect(reportMessage({ kind: 'storage_failed', error: new Error('disk') })).toBe(
    'storage failed. Error: disk',
  )
})

it('compaction by context window, with Pi settings replacing it field by field', () => {
  const settings = SettingsManager.inMemory({
    compaction: { modelOverrides: { 'openai-codex/gpt-6.1-sol': { keepRecentTokens: 9000 } } },
  })
  const windows: Record<string, number> = {
    'openai-codex/gpt-6.1-sol': 500_000,
    'anthropic/claude-opus-5-5': 1_000_000,
    'anthropic/claude-haiku-4-5': 200_000,
  }
  const { modelOverrides } = createHarnessSettings(
    settings,
    (provider, modelId) => windows[`${provider}/${modelId}`],
    () => [],
  ).compaction!
  expect(modelOverrides?.['openai-codex/gpt-6.1-sol']).toEqual({
    reserveTokens: 32768,
    keepRecentTokens: 9000,
    backgroundTokens: 65536,
  })
  // Named by its API provider, not claude-code/: it had Pi's 200k settings on a 1M window.
  expect(modelOverrides?.['anthropic/claude-opus-5-5']?.backgroundTokens).toBe(131072)
  expect(modelOverrides?.['anthropic/claude-haiku-4-5']).toEqual({})
})
