/* License — Copyright (c) 2025 Paperclip AI (MIT). Derived from Paperclip local-process-sandbox.ts. */
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { BlockList, connect, isIP, type Socket } from 'node:net'

const SOCKET_PATH_MAX_BYTES = 107
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

export function parseAllow(entries: unknown): string[] {
  if (!Array.isArray(entries))
    throw new Error('allow must be an array of "host" or "host:port" strings')
  return entries.map((entry) => {
    const match = typeof entry === 'string' ? /^([^:]+)(?::(\d{1,5}))?$/.exec(entry) : null
    if (!match || !HOST_PATTERN.test(match[1]) || Number(match[2] ?? 443) > 65535)
      throw new Error(
        `Invalid allow entry ${JSON.stringify(entry)}: use "host" or "host:port", exact hostnames only`,
      )
    return `${match[1].toLowerCase()}:${match[2] ?? '443'}`
  })
}

const nonPublic = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv6')

async function publicAddress(host: string) {
  if (isIP(host)) return host
  const { address, family } = await lookup(host)
  return nonPublic.check(address, family === 6 ? 'ipv6' : 'ipv4') ? undefined : address
}

export async function startProxy(
  socketPath: string,
  allow: readonly string[],
): Promise<{ close(): Promise<void> }> {
  const bytes = Buffer.byteLength(socketPath)
  if (bytes > SOCKET_PATH_MAX_BYTES)
    throw new Error(
      `Proxy socket path is ${bytes} bytes, over the Linux limit of ${SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    )
  const allowed = new Set(parseAllow(allow))
  const forbidden = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  const server = createServer((_request, response) => {
    response.writeHead(403, { Connection: 'close', 'Content-Length': 0 }).end()
  })
  server.on('connect', (request, client, head) => {
    const url = request.url ?? ''
    const separator = url.lastIndexOf(':')
    const host = separator > 0 ? url.slice(0, separator).replace(/^\[|\]$/g, '') : url
    const port = separator > 0 ? url.slice(separator + 1) : '443'
    if (!/^\d+$/.test(port) || !allowed.has(`${host.toLowerCase()}:${Number(port)}`)) {
      client.end(forbidden)
      return
    }
    client.on('error', () => client.destroy())
    void publicAddress(host).then(
      (address) => {
        if (client.destroyed) return
        if (!address) {
          client.end(forbidden)
          return
        }
        const upstream = connect(Number(port), address, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) upstream.write(head)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        const closeBoth = () => {
          client.destroy()
          upstream.destroy()
        }
        upstream.on('error', closeBoth)
        client.on('close', closeBoth)
      },
      () => client.end(forbidden),
    )
  })
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await rm(socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
    },
  }
}
