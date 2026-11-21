import { join } from 'node:path'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { installCopilotThinkingFix } from '../copilot-thinking.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

it('hides thinking off for Copilot claude-sonnet-5.5, which rejects the disabled request, and restores it on close', async () => {
  const root = await temp()
  cleanup.push(root)
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(root, 'auth.json'),
    refreshOnCreate: false,
  })
  const model = (id: string) => runtime.getModel('github-copilot', id)!
  expect(getSupportedThinkingLevels(model('claude-sonnet-5.5'))).toContain('off')

  const closers: (() => Promise<void>)[] = []
  const resources = new Map<string, unknown>()
  const host = {
    modelRuntime: runtime,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onClose: (callback: () => Promise<void>) => closers.push(callback),
  } as unknown as ExtensionHost
  installCopilotThinkingFix(host)

  expect(getSupportedThinkingLevels(model('claude-sonnet-5.5'))).not.toContain('off')
  expect(clampThinkingLevel(model('claude-sonnet-5.5'), 'off')).not.toBe('off')
  expect(clampThinkingLevel(model('claude-sonnet-5.5'), 'high')).toBe('high')
  expect(getSupportedThinkingLevels(model('claude-sonnet-5'))).toContain('off')

  installCopilotThinkingFix(host)
  await closers[0]()
  expect(getSupportedThinkingLevels(model('claude-sonnet-5.5'))).not.toContain('off')
  await closers[1]()
  expect(getSupportedThinkingLevels(model('claude-sonnet-5.5'))).toContain('off')
})
