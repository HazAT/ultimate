import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseAllow, startProxy } from '../proxy.ts'
import { temp, until } from '../../../test/helpers.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).toReversed()) await fn()
})

async function setup(allowPort: (port: number) => string[]) {
  const echo: Server = createServer((socket) => socket.pipe(socket))
  echo.listen(0, '127.0.0.1')
  await once(echo, 'listening')
  const port = (echo.address() as { port: number }).port
  cleanup.push(() => new Promise((resolve) => echo.close(resolve)))
  const socketPath = join(await temp('sbx-'), 'p.sock')
  const proxy = await startProxy(socketPath, allowPort(port))
  cleanup.push(() => proxy.close())
  return { port, socketPath, proxy }
}

async function send(socketPath: string, request: string) {
  const socket = connect(socketPath)
  cleanup.push(() => socket.destroy())
  let received = ''
  socket.on('data', (chunk) => (received += chunk))
  socket.write(request)
  return { socket, received: () => received }
}

const connectRequest = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`

it('tunnels an allowed target', async () => {
  const { port, socketPath } = await setup((p) => [`127.0.0.1:${p}`])
  const { socket, received } = await send(socketPath, connectRequest(`127.0.0.1:${port}`))
  await until(() => received().includes('200 Connection Established'))
  socket.write('hello')
  await until(() => received().endsWith('hello'))
  expect(received()).toMatch(/^HTTP\/1.1 200/)
})

it('answers 403 for a port or host that is not allowed', async () => {
  const { port, socketPath } = await setup((p) => [`127.0.0.1:${p}`])
  for (const target of [`127.0.0.1:${port + 1}`, `localhost:${port}`]) {
    const { received } = await send(socketPath, connectRequest(target))
    await until(() => received().startsWith('HTTP/1.1 403'))
    expect(received()).toContain('403')
  }
})

it('answers 403 for a request that is not CONNECT', async () => {
  const { socketPath } = await setup(() => ['127.0.0.1'])
  const { received } = await send(
    socketPath,
    'GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
  )
  await until(() => received().startsWith('HTTP/1.1 403'))
  expect(received()).toContain('403')
})

it('removes the socket file on close', async () => {
  const { socketPath, proxy } = await setup(() => [])
  expect(existsSync(socketPath)).toBe(true)
  await proxy.close()
  expect(existsSync(socketPath)).toBe(false)
})

it('validates allow entries', () => {
  expect(parseAllow(['Registry.NPMJS.org', 'example.com:8443'])).toEqual([
    'registry.npmjs.org:443',
    'example.com:8443',
  ])
  expect(() => parseAllow(['*.example.com'])).toThrow('"*.example.com"')
  expect(() => parseAllow('example.com')).toThrow('array')
  expect(() => parseAllow([5])).toThrow('5')
})

it('refuses a socket path over 107 bytes', async () => {
  await expect(startProxy('/tmp/' + 'a'.repeat(110), [])).rejects.toThrow('107')
})
