import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { ActionError, createApi, readActionOf } from '../../web/src/sdk/api.ts'
import { createStore } from '../../web/src/sdk/store.ts'
import { createUiState } from '../../web/src/sdk/ui-state.ts'
import { actionRef } from '../../shared/extension-api.ts'

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    respond(input as string, init!),
  )
  const api = createApi(createStore(), { fetch })
  const readAction = readActionOf(api)
  return { api, readAction, fetch }
}
const ref = (extension: string, name: string) => actionRef<unknown, unknown>(extension, name)
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('extension actions', () => {
  it('posts args for the shown conversation and resolves with the result', async () => {
    const { api, fetch } = setup(() => json(200, { result: { notes: [1, 2] } }))
    expect(await api.action(ref('notes', 'list notes'), { folder: 'drafts' })).toEqual({
      notes: [1, 2],
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/extensions/notes/actions/list%20notes')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      args: { folder: 'drafts' },
      conversationId: 1,
    })
    await api.action(ref('notes', 'list'), null, { conversationId: 7 as ConversationId })
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      args: null,
      conversationId: 7,
    })
  })

  it('returns revisions for read actions while ordinary actions still return only the result', async () => {
    const { api, readAction, fetch } = setup(() => json(200, { result: ['draft'], rev: 42 }))
    const read = ref('notes', 'list')
    await expect(readAction(read)).resolves.toEqual({ result: ['draft'], rev: 42 })
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ args: null })
    await expect(api.action(read)).resolves.toEqual(['draft'])
  })

  it('rejects with an ActionError naming the extension, action, status, and message', async () => {
    const { readAction } = setup(() => json(500, { error: 'Extension action failed', rev: 23 }))
    const error = await readAction(ref('notes', 'save'), 'x').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ActionError)
    expect(error).toMatchObject({
      extension: 'notes',
      action: 'save',
      status: 500,
      message: 'Extension action failed',
      rev: 23,
    })
    const missing = setup(() => json(404, { error: 'Unknown extension action' }))
    await expect(missing.api.action(ref('notes', 'nope'))).rejects.toMatchObject({ status: 404 })
  })

  it('treats truncated or malformed 200 bodies as status-0 transport failures while keeping null and stamped no-value answers', async () => {
    for (const body of ['{truncated', '[]', '{"ok":true}', '{"result":"x","rev":"bad"}']) {
      const { api, readAction } = setup(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      )
      await expect(readAction(ref('notes', 'list'))).rejects.toMatchObject({
        status: 0,
        extension: 'notes',
        action: 'list',
      })
      await expect(api.action(ref('notes', 'list'))).rejects.toMatchObject({ status: 0 })
    }
    const explicitNull = setup(() => json(200, { result: null, rev: 7 }))
    await expect(explicitNull.readAction(ref('notes', 'list'))).resolves.toEqual({
      result: null,
      rev: 7,
      superseded: undefined,
    })
    const stampedNoValue = setup(() => json(200, { rev: 8 }))
    await expect(stampedNoValue.readAction(ref('notes', 'list'))).resolves.toEqual({
      result: undefined,
      rev: 8,
      superseded: undefined,
    })
    const badErrorRev = setup(
      () =>
        new Response('{"error":"temporary","rev":1e400}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const err = await badErrorRev
      .readAction(ref('notes', 'list'))
      .catch((failure: unknown) => failure)
    expect(err).toBeInstanceOf(ActionError)
    expect(err).toMatchObject({ status: 500, message: 'temporary', rev: undefined })
  })

  it('fails a 503 like any other server error', async () => {
    const unavailable = setup(() => json(503, { error: 'Service unavailable' }))
    await expect(unavailable.api.action(ref('onboarding', 'status'))).rejects.toBeInstanceOf(
      ActionError,
    )
    await expect(unavailable.api.updateUi({ ops: [] })).rejects.toMatchObject({ status: 503 })
  })

  it('sends a page-exit UI-state flush to /api/ui with keepalive', async () => {
    const { api, fetch } = setup(() => json(200, { ok: true, rev: 1 }))
    const state = createUiState(api.updateUi)
    state.set('ext.digest.on', true)
    await state.exit()
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.keepalive])).toEqual([
      ['/api/ui', true],
    ])
  })

  it('passes an abort through as an abort, not an action failure', async () => {
    const controller = new AbortController()
    const { api } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    )
    const pending = api.action(ref('notes', 'slow'), null, { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(ActionError)
    expect((error as Error).name).toBe('AbortError')
  })
})
