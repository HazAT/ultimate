import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { ExtensionHost } from './extensions.ts'

type PrivateFile = { file: FileHandle; name: string; type: 'video/webm' }

export type ExtensionFiles = (
  id: string,
  key: string,
  ctx: { host: ExtensionHost },
) => Promise<PrivateFile | undefined>

export const privateFilesPath = /^\/api\/extensions\/[^/]+\/files(?:\/|$)/
const filePath =
  /^\/api\/extensions\/([A-Za-z0-9_-]{1,128})\/files\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
  if (!match || !size) return undefined
  const [, first, last] = match
  if (!first) {
    const suffix = Number(last)
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : undefined
  }
  const start = Number(first)
  const end = last ? Math.min(Number(last), size - 1) : size - 1
  return start <= end ? { start, end } : undefined
}

function filename(name: string) {
  return (
    name
      .slice(0, 120)
      .replace(/[^A-Za-z0-9 ._-]/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '') || 'video.webm'
  )
}

export async function servePrivateFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  resolve: (extension: string, id: string, key: string) => ReturnType<ExtensionFiles>,
): Promise<403 | 404 | void> {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  if (request.headers['sec-fetch-site'] !== 'same-origin') return 403
  if (request.method !== 'GET' && request.method !== 'HEAD') return 404
  const path = request.url?.split('?', 1)[0]
  const match = path === url.pathname && filePath.exec(path)
  if (!match) return 404
  const result = await resolve(match[1], match[2], match[3])
  if (!result) return 404
  const { file, type, name } = result
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || type !== 'video/webm') return 404
    if (response.destroyed) return
    const size = stat.size
    const header =
      request.method === 'GET' && request.headers['if-range'] === undefined
        ? request.headers.range
        : undefined
    const range = header === undefined ? undefined : byteRange(header, size)
    response.setHeader('Accept-Ranges', 'bytes')
    if (header !== undefined && !range) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }).end()
      return
    }
    const length = range ? range.end - range.start + 1 : size
    response.writeHead(range ? 206 : 200, {
      'Content-Disposition': `inline; filename="${filename(name)}"`,
      'Content-Type': type,
      'Content-Length': length,
      ...(range && { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` }),
    })
    if (request.method === 'GET' && length > 0)
      await pipeline(file.createReadStream(range ?? { start: 0, end: size - 1 }), response)
    else response.end()
  } finally {
    await file.close()
  }
}
