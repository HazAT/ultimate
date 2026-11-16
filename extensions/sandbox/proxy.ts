/* License — Copyright (c) 2025 Paperclip AI (MIT). Derived from Paperclip local-process-sandbox.ts. */
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'

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
    const upstream = connect(Number(port), host, () => {
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
    client.on('error', closeBoth)
    client.on('close', closeBoth)
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
