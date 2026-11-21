import { truncate, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { extensionFileUrl } from '../web/src/sdk/extension-files.ts'
import { post, until } from './helpers.ts'
import { fixture } from './server-fixture.ts'

const headers = { 'Sec-Fetch-Site': 'same-origin' }
const remoteOrigin = 'https://private.example:5799'
const source = (asset: string) => `
  import { open } from 'node:fs/promises'
  export default host => {
    host.access.allow({ origin: '${remoteOrigin}', verify: ({ headers }) => headers['test-login'] === 'owner' ? { login: 'owner' } : undefined })
    return { name: 'private-media' }
  }
  let lastFile
  export const actions = { closed: async () => lastFile?.fd === -1 }
  export const files = async (id, key, { host }) => {
    if (id !== 'one' || !['clip', 'directory'].includes(key)) return
    lastFile = await open(key === 'directory' ? host.home : host.home + '/${asset}', 'r')
    return { file: lastFile, type: 'video/webm', name: '../bad"\\r\\nname.webm' }
  }
`
const fileUrl = (key = 'clip') => extensionFileUrl('private-media', 'one', key)

it('serves private WebM with one byte range and no body for HEAD or unusable ranges', async () => {
  const { server, options } = await fixture(false, { 'private-media': source('asset') })
  await writeFile(join(options.home, 'asset'), '0123456789')
  const get = (extra?: Record<string, string>, method = 'GET') =>
    fetch(server.url + fileUrl(), { method, headers: { ...headers, ...extra } })
  const full = await get()
  expect(full.status).toBe(200)
  expect(Object.fromEntries(full.headers)).toMatchObject({
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-disposition': 'inline; filename="_bad___name.webm"',
    'content-length': '10',
    'content-type': 'video/webm',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  })
  expect(await full.text()).toBe('0123456789')
  const head = await get({ Range: 'bytes=2-4' }, 'HEAD')
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe('10')
  expect(await head.text()).toBe('')
  for (const [header, bounds, content] of [
    ['bytes=2-4', '2-4', '234'],
    ['bytes=8-', '8-9', '89'],
    ['bytes=-2', '8-9', '89'],
    ['bytes=8-15', '8-9', '89'],
  ]) {
    const part = await get({ Range: header })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes ${bounds}/10`)
    expect(part.headers.get('content-length')).toBe(String(content.length))
    expect(await part.text()).toBe(content)
  }
  for (const header of ['bytes=10-', 'bytes=5-3', 'bytes=-0', 'bytes=1-2,4-5', 'not a range']) {
    const invalid = await get({ Range: header })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */10')
    expect(await invalid.text()).toBe('')
  }
  const conditional = await get({ Range: 'bytes=8-', 'If-Range': '"old"' })
  expect(conditional.status).toBe(200)
  expect(await conditional.text()).toBe('0123456789')
})

it('requires both admission and same-origin metadata, and follows the installed facet', async () => {
  const { server, options } = await fixture(false, { 'private-media': source('first') })
  await writeFile(join(options.home, 'first'), 'first')
  await writeFile(join(options.home, 'next'), 'next')
  const wire = (path = fileUrl(), sent: Record<string, string> = headers, method = 'GET') =>
    new Promise<number>((resolve, reject) => {
      request(server.url, { path, headers: sent, method }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode!))
        response.on('error', reject)
      })
        .on('error', reject)
        .end()
    })
  expect(await wire()).toBe(200)
  expect(await wire(fileUrl(), {})).toBe(403)
  for (const site of ['none', 'same-site', 'cross-site'])
    expect(await wire(fileUrl(), { 'Sec-Fetch-Site': site })).toBe(403)
  expect(await wire(fileUrl(), { ...headers, Host: 'foreign.example' })).toBe(403)
  expect(await wire(fileUrl(), { ...headers, Origin: 'https://foreign.example' })).toBe(403)
  const remote = { ...headers, Host: new URL(remoteOrigin).host }
  expect(await wire(fileUrl(), remote)).toBe(403)
  expect(await wire(fileUrl(), { ...remote, 'test-login': 'owner' })).toBe(200)
  expect(await wire(fileUrl(), headers, 'POST')).toBe(404)
  for (const path of [
    extensionFileUrl('unknown', 'one', 'clip'),
    extensionFileUrl('prompt', 'one', 'clip'),
    fileUrl('unknown'),
    '/api/extensions/private-media/files/ignored/../one/clip',
    '/api/extensions/private-media/files/one/%63lip',
    '/api/extensions/private-media/files/one/clip/extra',
  ])
    expect(await wire(path)).toBe(404)
  expect(() => extensionFileUrl('private-media', '..', 'clip')).toThrow(
    'Invalid extension file address',
  )

  const facet = join(options.ultimateRoot, 'extensions/private-media/server.ts')
  const installed = () => server.extensions.info().find((entry) => entry.name === 'private-media')
  const content = async () => (await fetch(server.url + fileUrl(), { headers })).text()
  await writeFile(facet, "export default { name: 'private-media' }; export const files = false")
  server.vite.watcher.emit('change', facet)
  await until(() => installed()?.server?.error?.includes('files must be a function') === true)
  expect(await content()).toBe('first')
  await writeFile(facet, source('next'))
  server.vite.watcher.emit('change', facet)
  await until(async () => (await content()) === 'next')
  const settings = join(options.ultimateRoot, '.ultimate/settings.json')
  await writeFile(settings, '{"extensions":{"disable":["private-media"]}}')
  server.vite.watcher.emit('change', settings)
  await until(() => installed()?.enabled === false)
  expect(await wire()).toBe(404)
})

it('closes a rejected directory handle and a streamed handle when the client disconnects', async () => {
  const { server, options } = await fixture(false, { 'private-media': source('asset') })
  const closed = async () =>
    (await post(server, '/api/extensions/private-media/actions/closed')).data.result === true
  const directory = await fetch(server.url + fileUrl('directory'), { headers })
  expect(directory.status).toBe(404)
  await directory.text()
  expect(await closed()).toBe(true)

  const asset = join(options.home, 'asset')
  await writeFile(asset, '')
  await truncate(asset, 32 * 1024 * 1024)
  await new Promise<void>((resolve, reject) => {
    request(server.url, { path: fileUrl(), headers }, (response) => {
      response.on('error', reject)
      response.once('data', () => {
        response.destroy()
        if (response.statusCode === 200 && !response.complete) resolve()
        else reject(new Error('Expected to disconnect during a stream'))
      })
    })
      .on('error', reject)
      .end()
  })
  await until(closed)
})
