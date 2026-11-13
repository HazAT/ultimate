import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { readFile } from 'node:fs/promises'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterEach, expect, it } from 'vitest'
import healthExtension, { announce, responseEntry } from '../server.ts'
import { HealthApi } from '../api.ts'
import { actions as models } from '../../models/server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { failureKind, healthPath, merge, readHealth, record, sanitize, state } from '../store.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { prepareHarness } from '../../../server/harness.ts'
import { LoginChanged } from '../../models/api.ts'
import { Changed as HealthChanged } from '../refs.ts'
import { apis, eventHost, removeTemps, temp, until } from '../../../test/helpers.ts'

afterEach(removeTemps)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = 1_000 * HOUR

const message = (stopReason: AssistantMessage['stopReason'], errorMessage?: string) =>
  ({ provider: 'anthropic', stopReason, errorMessage }) as AssistantMessage

it('computes a provider state from its latest success, auth failure and transient streak', () => {
  expect(state({})).toBe('unknown')
  expect(state({ lastOk: 5 })).toBe('ok')
  expect(state({ lastOk: 5, lastFail: 6 })).toBe('ok')
  expect(state({ lastOk: 5, lastFail: 6, lastAuth: 6 })).toBe('failing')
  expect(state({ lastFail: 6, lastAuth: 6 })).toBe('failing')
  expect(state({ lastOk: 7, lastFail: 6, lastAuth: 6 })).toBe('ok')
  expect(state({ lastOk: 5, lastFail: 8, transient: [6, 7, 8] })).toBe('failing')
  expect(state({ lastOk: 6, lastFail: 8, transient: [6, 7, 8] })).toBe('ok')
})

it('classifies failures as auth, capacity or transient', () => {
  expect(failureKind('400 {"error":"invalid_grant"}')).toBe('auth')
  expect(failureKind('Request failed with status 403')).toBe('auth')
  expect(failureKind('529 overloaded_error: Overloaded')).toBe('capacity')
  expect(failureKind('429 rate_limit_error')).toBe('capacity')
  expect(failureKind('fetch failed: ETIMEDOUT')).toBe('transient')
  expect(failureKind('request failed')).toBe('transient')
})

it('reports a 402 streak as a billing failure, not a broken login', async () => {
  // OpenRouter's in_flight_budget_exhausted came back as 402 and the setup popover said "Log in again".
  const home = await temp()
  expect(failureKind('402 Payment Required')).toBe('billing')
  await record(home, 'p', { lastOk: NOW })
  for (let i = 1; i <= 3; i++) await record(home, 'p', { lastFail: NOW + i, error: '402' })
  expect(await readHealth(home, NOW + 4)).toMatchObject([
    { provider: 'p', state: 'failing', cause: 'billing', error: '402' },
  ])
})

it('counts a provider failing only after an auth error or a transient streak', async () => {
  const home = await temp()
  const states = async () => (await readHealth(home)).map((entry) => entry.state)
  const fail = (at: number, error: string) => record(home, 'p', { lastFail: at, error })
  await record(home, 'p', { lastOk: NOW })
  // One transient failure after a success stays ok, and so does a second.
  expect(await fail(NOW + 1, 'request failed')).toMatchObject({ from: 'ok', to: 'ok' })
  expect(await fail(NOW + 2, 'ETIMEDOUT')).toMatchObject({ to: 'ok' })
  // The third in a row flips it, with its error.
  expect(await fail(NOW + 3, 'request failed')).toEqual({
    provider: 'p',
    from: 'ok',
    to: 'failing',
    error: 'request failed',
  })
  // A success resets the count: two more failures stay ok.
  expect(await record(home, 'p', { lastOk: NOW + 4 })).toMatchObject({ to: 'ok' })
  await fail(NOW + 5, 'request failed')
  await fail(NOW + 6, 'request failed')
  expect(await states()).toEqual(['ok'])
  // A failure five minutes after the streak began, with no success between, flips it too.
  await record(home, 'p', { lastOk: NOW + 7 })
  await fail(NOW + 8, 'ETIMEDOUT')
  expect(await fail(NOW + 8 + 5 * MINUTE, 'ETIMEDOUT')).toMatchObject({ to: 'failing' })
  // Capacity errors never flip, however many, but stay the last error.
  await record(home, 'p', { lastOk: NOW + HOUR })
  for (let i = 1; i <= 5; i++) await fail(NOW + HOUR + i * MINUTE, '529 overloaded_error')
  expect(await readHealth(home)).toEqual([
    {
      provider: 'p',
      state: 'ok',
      lastOk: NOW + HOUR,
      lastFail: NOW + HOUR + 5 * MINUTE,
      error: '529 overloaded_error',
    },
  ])
  // A capacity error in a transient streak neither counts nor stretches its 5-minute window.
  await record(home, 'p', { lastOk: NOW + HOUR + 6 * MINUTE })
  await fail(NOW + HOUR + 7 * MINUTE, 'ETIMEDOUT')
  await fail(NOW + HOUR + 13 * MINUTE, '429 rate_limit_error')
  expect(await states()).toEqual(['ok'])
  // An auth error flips at once, and a later success clears it.
  expect(await fail(NOW + 2 * HOUR, '401 invalid_grant')).toMatchObject({ to: 'failing' })
  expect(await record(home, 'p', { lastOk: NOW + 3 * HOUR })).toMatchObject({
    from: 'failing',
    to: 'ok',
  })
})

it('counts a transient streak the same whatever order its writes arrive in', async () => {
  const home = await temp()
  for (const at of [NOW + 1, NOW + 2, NOW + 3])
    await record(home, 'p', { lastFail: at, error: 'ETIMEDOUT' })
  // A success older than all three, written last, leaves them counting.
  expect(await record(home, 'p', { lastOk: NOW })).toMatchObject({ from: 'failing', to: 'failing' })
  // One between them breaks the streak.
  expect(await record(home, 'p', { lastOk: NOW + 2 })).toMatchObject({ to: 'ok' })
})

it('merges each timestamp by its maximum and keeps the newest failure’s error', () => {
  expect(
    merge(
      { lastOk: 10, lastFail: 3, error: 'old', lastUsed: 10 },
      { lastOk: 4, lastFail: 8, error: 'new' },
    ),
  ).toEqual({ lastOk: 10, lastFail: 8, error: 'new', lastUsed: 10 })
  // An older failure arriving late does not replace the newer error.
  expect(merge({ lastFail: 8, error: 'new' }, { lastFail: 3, error: 'old' })).toEqual({
    lastFail: 8,
    error: 'new',
  })
})

it('summarises errors to a status, error codes and known keywords', () => {
  expect(
    sanitize('400 {"error":"invalid_grant","error_description":"Refresh token revoked"}'),
  ).toBe('400 invalid_grant revoked')
  expect(sanitize('429 rate_limit_error: Too many requests')).toBe('429 rate_limit_error')
  expect(sanitize('Request failed with status 401: Unauthorized')).toBe('401 unauthorized')
  expect(sanitize('fetch failed: ECONNREFUSED 127.0.0.1:443')).toBe('ECONNREFUSED')
  expect(sanitize('Something odd happened')).toBe('request failed')
  expect(sanitize('a_b_c '.repeat(300))).toBe('request failed')
})

it('sanitises every credential format it can recognise, keeping provider error codes', () => {
  const secrets = [
    'authorization: bearer lowercaseSecret1',
    'Authorization: Basic dXNlcjpwYXNz',
    'refresh_token=rt.Abc123secret&x',
    '{"access_token":"opaqueSecret99"}',
    'api_key: plainSecret7',
    'x-api-key=keySecret8',
    'ghp_ghSecretValue1',
    'xoxb-slackSecret-2',
    'opaque 4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c',
    'cookie=sessionSecret3',
    'Cookie: session=cookieSecret4; other=val_secret_x',
    'password: "my Secret pass phrase"',
    'Invalid key sk-ant-api03-SECRETsecret_42 with eyJhbGciOi.x.y',
    'token lower_case_secret_value',
    // Review findings: a numeric password on its own line, a token whose parts look like snake_case.
    'Login rejected\npassword:\n429\n',
    'Bad credentials ghp_abcd_efgh',
    'my_secret_pass_word leaked',
  ]
  const leaked = secrets.filter((text) =>
    /secret|dXNlcjpwYXNz|4f9a8b7c6d5e|eyJ|pass|ghp|abcd|429/i.test(sanitize(text)),
  )
  expect(leaked).toEqual([])
})

it('records real responses in the machine’s health file, merging concurrent writes', async () => {
  const home = await temp()
  expect(responseEntry(message('aborted'), NOW)).toBeUndefined()
  expect(responseEntry(message('stop'), NOW)).toEqual({ lastOk: NOW, lastUsed: NOW })
  expect(responseEntry(message('toolUse'), NOW)).toEqual({ lastOk: NOW, lastUsed: NOW })
  const failed = responseEntry(message('error', '401 invalid_grant for sk-live-123abc'), NOW + 1)!
  expect(failed).toMatchObject({ lastFail: NOW + 1, lastUsed: NOW + 1 })

  await Promise.all([
    record(home, 'anthropic', responseEntry(message('stop'), NOW)!),
    record(home, 'anthropic', failed),
    record(home, 'openai', { lastOk: NOW }),
  ])
  expect(await readHealth(home)).toEqual([
    {
      provider: 'anthropic',
      state: 'failing',
      cause: 'auth',
      lastOk: NOW,
      lastFail: NOW + 1,
      lastUsed: NOW + 1,
      error: '401 invalid_grant',
    },
    { provider: 'openai', state: 'ok', lastOk: NOW },
  ])
  expect(await readFile(healthPath(home), 'utf8')).not.toContain('sk-live')
})

it('reads only providers with a login here, so a removed login leaves no stale failure', async () => {
  const home = await temp('ultimate-health-logins-')
  await record(home, 'openai', { lastFail: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastOk: NOW })
  const services = apis()
  healthExtension({
    ...services,
    faux: fauxProvider(),
    userHome: home,
    modelRuntime: {
      getProviderAuthStatus: (provider: string) => ({ configured: provider === 'openai-codex' }),
    },
    react: () => {},
  } as unknown as ExtensionHost)
  const providers = await services.need(HealthApi).providers()
  expect(providers.map((entry) => [entry.provider, entry.state])).toEqual([['openai-codex', 'ok']])
})

it("Ultimate's logout resets the provider's health through models.login-changed", async () => {
  const home = await temp('ultimate-health-logout-')
  await record(home, 'anthropic', { lastFail: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastFail: NOW, error: 'invalid_grant' })
  const prepared = await prepareHarness({
    home,
    ultimateRoot: home,
    userHome: home,
    faux: fauxProvider(),
  })
  const opened = await prepared.open()
  try {
    const events = eventHost(() => opened.harness, 'health')
    const logouts: string[] = []
    const host = {
      userHome: home,
      faux: fauxProvider(),
      ...apis(),
      harness: () => opened.harness,
      emit: events.emit,
      react: events.react,
      modelRuntime: { logout: async (provider: string) => void logouts.push(provider) },
    } as unknown as ExtensionHost
    healthExtension(host)
    await events.start()
    await models.logout({ provider: 'anthropic' }, { host } as ActionContext)
    await until(events.settled)
    expect(logouts).toEqual(['anthropic'])
    expect((await readHealth(home)).map((entry) => entry.provider)).toEqual(['openai-codex'])
    // Every login change resets: the next logout reaches health as well.
    await models.logout({ provider: 'openai-codex' }, { host } as ActionContext)
    await until(events.settled)
    expect(await readHealth(home)).toEqual([])
    expect(
      (await events.eventLog.recent({ events: [LoginChanged] })).map((event) => event.data),
    ).toEqual([{ provider: 'openai-codex' }, { provider: 'anthropic' }])
    // Each reset flipped a failing provider to unknown: one event each, in the reactor's commit.
    expect(
      (await events.eventLog.recent({ events: [HealthChanged] })).map((event) => event.data),
    ).toEqual([
      { provider: 'openai-codex', state: 'unknown' },
      { provider: 'anthropic', state: 'unknown' },
    ])
    // A write is announced only when it flips the state.
    await announce(host, [await record(home, 'anthropic', { lastOk: NOW })])
    await announce(host, [await record(home, 'anthropic', { lastOk: NOW + 1 })])
    await announce(host, [
      await record(home, 'anthropic', { lastFail: NOW + 2, error: '401 key sk-secret' }),
    ])
    expect(
      (await events.eventLog.recent({ events: [HealthChanged], limit: 2 })).map(
        (event) => event.data,
      ),
    ).toEqual([
      { provider: 'anthropic', state: 'failing', error: '401' },
      { provider: 'anthropic', state: 'ok' },
    ])
    expect(await events.eventLog.recent({ events: [HealthChanged] })).toHaveLength(4)
  } finally {
    await opened.close()
  }
})
