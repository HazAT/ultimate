import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import exa from '../extensions/exa/server.ts'
import { exaRequest } from '../extensions/exa/client.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})
async function fixture({ secrets = true, parallel = false } = {}) {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome: root,
    notice,
    resource: <T>(_key: string, create: () => T) => create(),
    extensions: () => [
      ...(secrets ? [{ name: 'secrets', enabled: true, server: {} }] : []),
      ...(parallel ? [{ name: 'parallel', enabled: true, server: {} }] : []),
    ],
  } as unknown as ExtensionHost
  const tools = exa(host).tools!
  const details = vi.fn<(value: unknown, context: unknown) => Promise<void>>(async () => {})
  const api = { details }
  const run = async (name: string, args: unknown, signal?: AbortSignal) => {
    const tool = tools.find((candidate) => candidate.name === name)!
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
    return tool.execute(prepared, api as never, { abortSignal: signal } as never)
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
  vi.stubEnv('ULTIMATE_EXA_TEST_URL', `http://127.0.0.1:${address.port}`)
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(errors).toEqual([])
  })
}
const page = {
  title: 'Example',
  url: 'https://example.com/',
  publishedDate: '2026-01-01',
  highlights: ['excerpt'],
}
const shown = {
  title: 'Example',
  url: 'https://example.com/',
  publish_date: '2026-01-01',
  excerpts: ['excerpt'],
}

it('refuses to load while parallel is on, since both register web_search and web_fetch', async () => {
  await expect(fixture({ parallel: true })).rejects.toThrow(
    'parallel is on and registers web_search and web_fetch too',
  )
})
it('sends search and contents bodies with the stored key, formats output and renderer details', async () => {
  const f = await fixture()
  await writeSecret(f.root, 'EXA_API_KEY', 'stored-sentinel')
  vi.stubEnv('EXA_API_KEY', 'environment')
  const requests: unknown[] = []
  await fake((body, path, key) => {
    requests.push({ body, path, key })
    return {
      data:
        path === '/search'
          ? { requestId: 's', results: [page], notices: [{ code: 'n', message: 'warning' }] }
          : { requestId: 'c', results: [{ ...page, text: 'full content' }], statuses: [] },
    }
  })
  const search = await f.run('web_search', {
    query: 'question',
    maxResults: 3,
    afterDate: '2026-01-01',
  })
  expect(requests[0]).toEqual({
    path: '/search',
    key: 'stored-sentinel',
    body: {
      query: 'question',
      type: 'auto',
      numResults: 3,
      startPublishedDate: '2026-01-01T00:00:00.000Z',
      contents: { highlights: true },
    },
  })
  expect(JSON.stringify(search)).toContain('Published: 2026-01-01')
  expect(JSON.stringify(search)).toContain('warning')
  expect(f.details.mock.calls[0][0]).toMatchObject({
    requestIds: ['s'],
    results: [shown],
    warnings: [{ type: 'n', message: 'warning' }],
  })
  const fetched = await f.run('web_fetch', { url: ['https://example.com'], objective: 'focus' })
  expect(requests[1]).toEqual({
    path: '/contents',
    key: 'stored-sentinel',
    body: {
      urls: ['https://example.com/'],
      text: { maxCharacters: 40000 },
      maxAgeHours: 24,
      highlights: { query: 'focus' },
    },
  })
  expect(JSON.stringify(fetched)).toContain('full content')
  expect(f.details.mock.calls[1][0]).toMatchObject({
    status: 'success',
    requestId: 'c',
    pages: [expect.objectContaining({ content: 'full content' })],
  })
  expect(JSON.stringify([search, fetched, f.details.mock.calls])).not.toContain('stored-sentinel')
})
it('runs keyword variants as separate searches guided by the query and merges them by rank without duplicates', async () => {
  const f = await fixture()
  vi.stubEnv('EXA_API_KEY', 'env-key')
  const bodies: Record<string, unknown>[] = []
  const result = (url: string) => ({ url, title: url, highlights: [url] })
  await fake((body) => {
    bodies.push(body)
    return {
      data: {
        results:
          body.query === 'one'
            ? [result('https://a.example/'), result('https://shared.example/')]
            : [result('https://shared.example/'), result('https://b.example/')],
      },
    }
  })
  await f.run('web_search', {
    query: 'question',
    searchQueries: ['one', 'two', 'one'],
    maxResults: 3,
  })
  expect(bodies.map((body) => [body.query, body.contents])).toEqual([
    ['one', { highlights: { query: 'question' } }],
    ['two', { highlights: { query: 'question' } }],
  ])
  expect(
    (f.details.mock.calls[0][0] as { results: { url: string }[] }).results.map((item) => item.url),
  ).toEqual(['https://a.example/', 'https://shared.example/', 'https://b.example/'])
})
it('reports pages that failed to fetch beside the ones that did, and fails when none did', async () => {
  const f = await fixture()
  vi.stubEnv('EXA_API_KEY', 'env-key')
  let results = [{ ...page, text: null }]
  await fake(() => ({
    data: {
      results,
      statuses: [
        { id: 'https://example.com/', status: 'success' },
        {
          id: 'https://bad.example/',
          status: 'error',
          error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
        },
      ],
    },
  }))
  const partial = await f.run('web_fetch', { url: ['https://example.com', 'https://bad.example'] })
  expect(JSON.stringify(partial)).toContain('https://bad.example/ — CRAWL_NOT_FOUND (HTTP 404)')
  // Without text, the page falls back to its highlights.
  expect(JSON.stringify(partial)).toContain('excerpt')
  expect(f.details.mock.calls[0][0]).toHaveProperty('status', 'partial')
  results = []
  expect(await f.run('web_fetch', { url: 'https://bad.example' })).toHaveProperty('isError', true)
})
it('reports a missing key or disabled secrets with one notice, even with environment credentials', async () => {
  vi.stubEnv('EXA_API_KEY', '')
  const f = await fixture()
  for (let i = 0; i < 2; i++)
    expect(JSON.stringify(await f.run('web_search', { query: 'test' }))).toContain('⌘K → Secrets')
  expect(f.notice).toHaveBeenCalledTimes(1)
  vi.stubEnv('EXA_API_KEY', 'env-key')
  const disabled = await fixture({ secrets: false })
  expect(JSON.stringify(await disabled.run('web_search', { query: 'test' }))).toContain(
    'EXA_API_KEY',
  )
})
it.each([
  [401, 'Secrets panel'],
  [402, 'out of credits'],
  [429, 'rate limit'],
  [500, '[redacted]'],
])(
  'maps HTTP %i errors with the request id and bounded redacted diagnostics',
  async (status, says) => {
    const f = await fixture()
    vi.stubEnv('EXA_API_KEY', 'secret-sentinel')
    await fake(() => ({
      status,
      data: { requestId: 'req-123', error: 'secret-sentinel ' + 'x'.repeat(1000), tag: 'X' },
    }))
    const output = await f.run('web_search', { query: 'test' })
    expect(output).toHaveProperty('isError', true)
    const text = JSON.stringify(output)
    expect(text).not.toContain('secret-sentinel')
    expect(text.length).toBeLessThan(800)
    expect(text).toContain(says)
    expect(f.details.mock.calls[0][0]).toHaveProperty('ref_id', 'req-123')
  },
)
it('redacts the key from successful payloads and never forwards a non-JSON error body', async () => {
  const f = await fixture()
  vi.stubEnv('EXA_API_KEY', 'echo-key')
  let status = 200
  await fake(() =>
    status === 200
      ? { data: { results: [{ ...page, highlights: ['echo-key said'] }] } }
      : { status, raw: 'echo-key raw confidential diagnostic' },
  )
  expect(JSON.stringify(await f.run('web_search', { query: 'test' }))).toContain('[redacted] said')
  status = 502
  const output = await f.run('web_search', { query: 'test' })
  expect(JSON.stringify(output)).toContain('HTTP 502')
  expect(JSON.stringify([output, f.details.mock.calls])).not.toMatch(/echo-key|confidential/)
})
it('maps invalid JSON, empty and malformed responses, and invalid URLs to tool errors', async () => {
  const f = await fixture()
  vi.stubEnv('EXA_API_KEY', 'env-key')
  let raw: string | undefined
  await fake(() => ({ raw }))
  for (const value of [
    'not json',
    'null',
    '{}',
    '{"results":[{"url":1}]}',
    '{"results":[{"url":"u","highlights":"x"}]}',
  ]) {
    raw = value
    expect(await f.run('web_search', { query: 'test' })).toHaveProperty('isError', true)
  }
  for (const url of [[], Array(21).fill('https://example.com'), 'file:///tmp/test', 'invalid'])
    expect(await f.run('web_fetch', { url })).toHaveProperty('isError', true)
})
it('maps abort, timeout and network failure without leaking diagnostic errors', async () => {
  await fake(() => ({ hang: true }))
  const controller = new AbortController()
  const request = exaRequest('/search', {}, controller.signal, 'key')
  controller.abort()
  await expect(request).rejects.toThrow('cancelled')
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
    AbortSignal.abort(new DOMException('Timeout', 'TimeoutError')),
  )
  await expect(exaRequest('/search', {}, undefined, 'key')).rejects.toThrow(
    'timed out after 120 seconds',
  )
  vi.restoreAllMocks()
  vi.stubEnv('ULTIMATE_EXA_TEST_URL', 'http://127.0.0.1:1')
  await expect(exaRequest('/search', {}, undefined, 'key')).rejects.toThrow('Could not reach')
})
