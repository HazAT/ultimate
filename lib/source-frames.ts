import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

/** `http://…/a.js:1:2` in a stack frame: the script's URL, line and column. */
const frame = /(https?:\/\/[^\s()]+?\.m?js):(\d+):(\d+)/g

/**
 * `text` with every bundled frame (`http://host/assets/web-x.js:1:1759`) replaced by the source position its script's
 * source map names (`/repo/extensions/a/web.tsx:56:25`), as dev tools show it. `read` reads a URL, or gives
 * undefined; frames without a map stay as they are.
 */
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

/**
 * A `read` for `sourceFrames` that fetches only `origin`'s own bundle assets. Error text comes from a page, which can
 * name any URL, so a frame's `/assets/…` path is requested from `origin` and its host is ignored: the server never
 * contacts another host, and pages served through `localhost`, Tailscale or other aliases still map. Asset names carry
 * a content hash, so a foreign page's `/assets/x.js` is a 404 here or the same file. Anything else, a malformed URL or
 * a slow response reads as no text and the frame stays as it is.
 */
export function fetchAssets(origin: string) {
  return async (url: string) => {
    try {
      const target = new URL(url)
      if (!target.pathname.startsWith('/assets/')) return undefined
      const response = await fetch(new URL(target.pathname + target.search, origin), {
        signal: AbortSignal.timeout(5000),
      })
      return response.ok ? await response.text() : undefined
    } catch {
      return undefined // Malformed, unreachable or timed out: the frame stays as it is.
    }
  }
}
