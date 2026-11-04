import { expect, it } from 'vitest'
import { sourceFrames } from '../lib/source-frames.ts'

// `function Crash(){throw new Error("x")}` from /repo/extensions/a/web.tsx line 3, column 9, in one minified line.
const script = 'function Crash(){throw new Error("x")}\n//# sourceMappingURL=web-1.js.map\n'
const map = JSON.stringify({
  version: 3,
  sources: ['/repo/extensions/a/web.tsx'],
  names: [],
  mappings: 'AAEQ',
})
const files: Record<string, string> = {
  'http://host/assets/web-1.js': script,
  'http://host/assets/web-1.js.map': map,
}

it('maps bundled frames to their source files and keeps the rest', async () => {
  const fetched: string[] = []
  const stack = [
    'Error: x',
    '    at Crash (http://host/assets/web-1.js:1:17)',
    '    at Crash (http://host/assets/web-1.js:1:17)',
    '    at Other (http://host/assets/gone.js:2:5)',
    '    at div (<anonymous>)',
  ].join('\n')
  const source = await sourceFrames(stack, async (url) => {
    fetched.push(url)
    return files[url]
  })
  expect(source).toBe(
    [
      'Error: x',
      '    at Crash (/repo/extensions/a/web.tsx:3:9)',
      '    at Crash (/repo/extensions/a/web.tsx:3:9)',
      '    at Other (http://host/assets/gone.js:2:5)',
      '    at div (<anonymous>)',
    ].join('\n'),
  )
  // Each script and its map are read once.
  expect(fetched).toEqual([
    'http://host/assets/web-1.js',
    'http://host/assets/gone.js',
    'http://host/assets/web-1.js.map',
  ])
})
