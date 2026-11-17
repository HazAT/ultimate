import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

const frame = /(https?:\/\/[^\s()]+?\.m?js):(\d+):(\d+)/g

export async function sourceFrames(
  text: string,
  read: (url: string) => Promise<string | undefined>,
  maps = new Map<string, Promise<TraceMap | undefined>>(),
) {
  const load = (script: string) => {
    let map = maps.get(script)
    if (!map) {
      map = read(script).then(async (code) => {
        const url = code && /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1]
        const json = url && (await read(new URL(url, script).href))
        return json ? new TraceMap(json) : undefined
      })
      maps.set(script, map)
    }
    return map
  }
  const found = [...text.matchAll(frame)]
  const resolved = await Promise.all(
    found.map(async ([, script, line, column]) => {
      const map = await load(script)
      const position =
        map && originalPositionFor(map, { line: Number(line), column: Number(column) - 1 })
      return position?.source && `${position.source}:${position.line}:${position.column + 1}`
    }),
  )
  let at = 0
  return found
    .map((match, index) => {
      const before = text.slice(at, match.index)
      at = match.index + match[0].length
      return before + (resolved[index] ?? match[0])
    })
    .join('')
    .concat(text.slice(at))
}

export function fetchAssets(origin: string) {
  return async (url: string) => {
    try {
      const untrustedFrameUrl = new URL(url)
      const isBundleAsset = untrustedFrameUrl.pathname.startsWith('/assets/')
      if (!isBundleAsset) return undefined
      const assetFromTrustedOrigin = new URL(
        untrustedFrameUrl.pathname + untrustedFrameUrl.search,
        origin,
      )
      const response = await fetch(assetFromTrustedOrigin, {
        signal: AbortSignal.timeout(5000),
      })
      return response.ok ? await response.text() : undefined
    } catch {
      return undefined
    }
  }
}
