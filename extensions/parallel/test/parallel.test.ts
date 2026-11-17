import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import parallel from '../server.ts'
import { parallelRequest } from '../client.ts'
import { truncateToolOutput } from '../output.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})
async function fixture(enabled = true) {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome: root,
    notice,
    resource: <T>(_key: string, create: () => T) => create(),
    extensions: () => (enabled ? [{ name: 'secrets', enabled: true, server: {} }] : []),
  } as unknown as ExtensionHost
  const tools = parallel(host).tools!
  const details = vi.fn<(value: unknown, context: unknown) => Promise<void>>(async () => {})
  const api = { details, agent: async () => ({ model: { modelId: 'test-model' } }) }
  const run = async (name: string, args: unknown, signal?: AbortSignal) => {
    const tool = tools.find((candidate) => candidate.name === name)!
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
    return tool.execute(prepared as never, api as never, { abortSignal: signal } as never)
  }
  return { root, run, details, notice }
}
async function fake(
  handler: (
    body: Record<string, unknown>,
    path: string,
    key: string | undefined,
  ) => { status?: number; data?: unknown; raw?: string; hang?: boolean },
) {
  const errors: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let text = ''
      for await (const chunk of request) text += chunk
      // A fetch cancelled just after dispatch can arrive without its JSON body.
      if (!text) {
        response.writeHead(400).end()
        return
      }
      const result = handler(
        JSON.parse(text),
        request.url!,
        request.headers['x-api-key'] as string | undefined,
      )
      if (result.hang) return
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
      response.end(result.raw ?? JSON.stringify(result.data))
    })().catch((error) => {
      // An interrupted upload is expected in cancellation tests; retain all other failures.
      if (!request.complete && request.destroyed) return
      errors.push(error)
      response.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  vi.stubEnv('ULTIMATE_PARALLEL_TEST_URL', `http://127.0.0.1:${address.port}`)
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(errors).toEqual([])
  })
}
it('rejects an empty upload without calling the JSON handler', async () => {
  const handler = vi.fn<() => { data: unknown }>(() => ({ data: {} }))
  await fake(handler)
  const response = await fetch(process.env.ULTIMATE_PARALLEL_TEST_URL + '/search', {
    method: 'POST',
  })
  expect(response.status).toBe(400)
  expect(handler).not.toHaveBeenCalled()
})
const page = {
  title: 'Example',
  url: 'https://example.com/',
  publish_date: '2026-01-01',
  excerpts: ['excerpt'],
}
it('sends search and extract bodies, stored key header, formats output and renderer details', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'PARALLEL_API_KEY', 'stored-sentinel')
  vi.stubEnv('PARALLEL_API_KEY', 'environment')
  const requests: unknown[] = []
  await fake((body, path, key) => {
    requests.push({ body, path, key })
    return {
      data:
        path === '/search'
          ? {
              search_id: 's',
              session_id: 'session',
              results: [page],
              warnings: [{ type: 'notice', message: 'warning' }],
            }
          : {
              extract_id: 'e',
              session_id: 'session',
              results: [{ ...page, full_content: 'full content' }],
              errors: [],
            },
    }
  })
  const search = await f.run('web_search', {
    query: 'question',
    searchQueries: ['keywords'],
    maxResults: 3,
    afterDate: '2026-01-01',
  })
  expect(requests[0]).toEqual({
    path: '/search',
    key: 'stored-sentinel',
    body: {
      objective: 'question',
      search_queries: ['keywords'],
      mode: 'turbo',
      max_chars_total: 40000,
      client_model: 'test-model',
      advanced_settings: { max_results: 3, source_policy: { after_date: '2026-01-01' } },
    },
  })
  expect(JSON.stringify(search)).toContain('Published: 2026-01-01')
  expect(JSON.stringify(search)).toContain('warning')
  expect(f.details.mock.calls[0][0]).toMatchObject({
    results: [page],
    warnings: [{ type: 'notice', message: 'warning' }],
  })
  const extract = await f.run('web_fetch', { url: ['https://example.com'], objective: 'focus' })
  expect(requests[1]).toEqual({
    path: '/extract',
    key: 'stored-sentinel',
    body: {
      urls: ['https://example.com/'],
      objective: 'focus',
      max_chars_total: 40000,
      client_model: 'test-model',
    },
  })
  expect(JSON.stringify(extract)).toContain('full content')
  expect(f.details.mock.calls[1][0]).toHaveProperty('pages')
  expect(JSON.stringify([search, extract, f.details.mock.calls])).not.toContain('stored-sentinel')
})
it('uses environment fallback; defaults search settings, formats partial extract errors and caps output', async () => {
  const f = await fixture()
  vi.stubEnv('PARALLEL_API_KEY', 'env-key')
  const requests: Record<string, unknown>[] = []
  await fake((body, path, key) => {
    requests.push(body)
    expect(key).toBe('env-key')
    if (path === '/search') {
      return {
        data: {
          search_id: 's',
          session_id: 'session',
          results: [{ ...page, excerpts: ['ü'.repeat(50000)] }],
        },
      }
    }
    return {
      data: {
        extract_id: 'e',
        session_id: 'session',
        results: [page],
        errors: [{ url: 'https://bad.example', error_type: 'unavailable', http_status_code: 404 }],
      },
    }
  })
  const result = await f.run('web_search', { query: 'question' })
  expect(requests[0].search_queries).toEqual(['question'])
  expect(requests[0].advanced_settings).toEqual({ max_results: 10 })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(52 * 1024)
  expect(JSON.stringify(result)).toContain('Output truncated')
  const partial = await f.run('web_fetch', { url: 'https://example.com' })
  expect(JSON.stringify(partial)).toContain('HTTP 404')
  expect(f.details.mock.calls.at(-1)?.[0]).toHaveProperty('status', 'partial')
  for (const input of ['ü'.repeat(100000), 'line\n'.repeat(3000)]) {
    const output = truncateToolOutput(input)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024)
    expect(output.split('\n').length).toBeLessThanOrEqual(2000)
  }
})
it('reports missing key or disabled secrets with one notice, even with environment credentials', async () => {
  vi.stubEnv('PARALLEL_API_KEY', '')
  const f = await fixture()
  for (let i = 0; i < 2; i++)
    expect(JSON.stringify(await f.run('web_search', { query: 'test' }))).toContain('⌘K → Secrets')
  expect(f.notice).toHaveBeenCalledTimes(1)
  vi.stubEnv('PARALLEL_API_KEY', 'env-key')
  const disabled = await fixture(false)
  expect(JSON.stringify(await disabled.run('web_search', { query: 'test' }))).toContain(
    'PARALLEL_API_KEY',
  )
})
it.each([401, 403, 429, 500])(
  'maps HTTP %i errors with ref_id and bounded redacted diagnostics',
  async (status) => {
    const f = await fixture()
    vi.stubEnv('PARALLEL_API_KEY', 'secret-sentinel')
    await fake(() => ({
      status,
      data: { error: { message: 'secret-sentinel ' + 'x'.repeat(1000), ref_id: 'ref-123' } },
    }))
    const output = await f.run('web_search', { query: 'test' })
    expect(output).toHaveProperty('isError', true)
    const text = JSON.stringify(output)
    expect(text).not.toContain('secret-sentinel')
    expect(text.length).toBeLessThan(800)
    expect(text).toContain(
      status === 429 ? 'rate limit' : status < 429 ? 'Secrets panel' : '[redacted]',
    )
    expect(f.details.mock.calls[0][0]).toHaveProperty('ref_id', 'ref-123')
  },
)
it.each(['quote"sentinel', 'escaped-sentinel'])(
  'redacts decoded credentials (%s) from errors, references and successful payloads',
  async (apiKey) => {
    const f = await fixture()
    await writeSecret(f.root, 'PARALLEL_API_KEY', apiKey)
    let status = 500
    await fake(() => {
      const data =
        status === 500
          ? { error: { message: `echo ${apiKey}`, ref_id: `ref-${apiKey}` } }
          : {
              search_id: 's',
              session_id: 'session',
              results: [{ ...page, excerpts: [`echo ${apiKey}`] }],
              warnings: [
                {
                  type: 'notice',
                  message: `warning ${apiKey}`,
                  detail: { nested: [{ [apiKey]: apiKey }] },
                },
              ],
            }
      const raw = JSON.stringify(data).replaceAll('escaped-sentinel', '\\u0065scaped-sentinel')
      return { status, raw }
    })
    const error = await f.run('web_search', { query: 'test' })
    expect(error).toHaveProperty('isError', true)
    expect(JSON.stringify(error)).toContain('[redacted]')
    expect(f.details.mock.calls[0][0]).toHaveProperty('ref_id', 'ref-[redacted]')
    status = 200
    const output = await f.run('web_search', { query: 'test' })
    expect(JSON.stringify(output)).toContain('echo [redacted]')
    expect(JSON.stringify([error, output, f.details.mock.calls])).not.toContain(apiKey)
    const payload = await parallelRequest('/search', {}, undefined, apiKey)
    expect(JSON.stringify(payload)).not.toContain(apiKey)
    expect(payload).toHaveProperty('warnings.0.detail.nested.0', { '[redacted]': '[redacted]' })
  },
)
it('never forwards a non-JSON HTTP error body', async () => {
  const f = await fixture()
  vi.stubEnv('PARALLEL_API_KEY', 'non-json-key')
  await fake(() => ({ status: 502, raw: 'non-json-key raw confidential diagnostic' }))
  const output = await f.run('web_search', { query: 'test' })
  expect(JSON.stringify(output)).toContain('HTTP 502')
  expect(JSON.stringify([output, f.details.mock.calls])).not.toMatch(/non-json-key|confidential/)
})
it('repairs JSON-string URL arrays without mutating arguments and preserves excerpt fallback', async () => {
  const f = await fixture()
  vi.stubEnv('PARALLEL_API_KEY', 'env-key')
  const requests: Record<string, unknown>[] = []
  await fake((body) => {
    requests.push(body)
    return { data: { extract_id: 'e', session_id: 'session', results: [page], errors: [] } }
  })
  const input = { url: '["https://example.com","https://other.example"]', objective: 'focus' }
  expect(await f.run('web_fetch', input)).toHaveProperty('isError', false)
  expect(input.url).toBe('["https://example.com","https://other.example"]')
  expect(requests[0].urls).toEqual(['https://example.com/', 'https://other.example/'])
  expect(await f.run('web_fetch', { url: '[invalid' })).toHaveProperty('isError', true)
})
it('maps invalid JSON, empty and malformed responses, invalid URLs, and total extract failure', async () => {
  const f = await fixture()
  vi.stubEnv('PARALLEL_API_KEY', 'env-key')
  let data: unknown = {}
  let raw: string | undefined
  await fake(() => ({ data, raw }))
  for (const value of [
    'not json',
    'null',
    '{}',
    '{"search_id":"s","session_id":"x","results":[{"url":1}]}',
  ]) {
    raw = value
    expect(await f.run('web_search', { query: 'test' })).toHaveProperty('isError', true)
  }
  raw = undefined
  data = {
    extract_id: 'e',
    session_id: 's',
    results: [],
    errors: [{ url: 'https://example.com', error_type: 'blocked' }],
  }
  expect(await f.run('web_fetch', { url: 'https://example.com' })).toHaveProperty('isError', true)
  for (const url of [[], Array(21).fill('https://example.com'), 'file:///tmp/test', 'invalid'])
    expect(await f.run('web_fetch', { url })).toHaveProperty('isError', true)
})
it('maps abort, timeout and network failure without leaking diagnostic errors', async () => {
  await fake(() => ({ hang: true }))
  const controller = new AbortController()
  const request = parallelRequest('/search', {}, controller.signal, 'key')
  controller.abort()
  await expect(request).rejects.toThrow('cancelled')
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
    AbortSignal.abort(new DOMException('Timeout', 'TimeoutError')),
  )
  await expect(parallelRequest('/search', {}, undefined, 'key')).rejects.toThrow(
    'timed out after 120 seconds',
  )
  vi.restoreAllMocks()
  vi.stubEnv('ULTIMATE_PARALLEL_TEST_URL', 'http://127.0.0.1:1')
  await expect(parallelRequest('/search', {}, undefined, 'key')).rejects.toThrow('Could not reach')
})
