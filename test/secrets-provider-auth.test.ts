// Pi upstream: @earendil-works/pi-coding-agent@1.6.0 dist/core/model-runtime.js — the patched ModelRuntime.create() takes authContext. Drop with the patch when upstream accepts it.
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { writeSecret } from '../extensions/secrets/store.ts'
import { secretsAuthContext } from '../lib/secrets.ts'
import { removeTemp, temp } from './helpers.ts'

const homes: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) await removeTemp(home)
})

it('a provider key stored in Secrets configures its provider until it is deleted', async () => {
  const home = await temp()
  homes.push(home)
  vi.stubEnv('GEMINI_API_KEY', undefined)
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(home, 'auth.json'),
    authContext: secretsAuthContext(home),
  })
  const google = async () => ({
    status: runtime.getProviderAuthStatus('google'),
    neon: (await runtime.getAvailable()).some(
      (model) => model.provider === 'google' && model.id === 'gemini-4-neon',
    ),
  })
  expect(await google()).toEqual({ status: { configured: false }, neon: false })

  await writeSecret(home, 'GEMINI_API_KEY', 'test-sentinel')
  await runtime.refresh({ allowNetwork: false })
  expect(await google()).toMatchObject({ status: { configured: true }, neon: true })
  expect((await runtime.getAuth('google'))?.auth.apiKey).toBe('test-sentinel')

  vi.stubEnv('GEMINI_API_KEY', 'environment-key')
  expect((await runtime.getAuth('google'))?.auth.apiKey).toBe('environment-key')
  vi.stubEnv('GEMINI_API_KEY', undefined)

  await writeSecret(home, 'GEMINI_API_KEY')
  await runtime.refresh({ allowNetwork: false })
  expect(await google()).toEqual({ status: { configured: false }, neon: false })
})
