import { expect, it } from 'vitest'
import type { SystemInfo } from '../../shared/protocol.ts'
import { errorReport, stackFrames } from '../../web/src/app/error-report.ts'

const system = {
  build: { id: 'b1', generation: 4 },
  machine: { home: '/home/me' },
  code: { ultimateRoot: '/home/me/ultimate' },
  project: { root: '/home/me/my-app' },
  extensions: [{ name: 'shell', source: 'user', path: '/home/me/.ultimate/extensions/shell' }],
} as unknown as SystemInfo

it('reports a failed load with its full message, path, source and build', () => {
  const message = "The requested module '/@fs/x.ts' does not provide an export named 'attention'"
  expect(
    errorReport(system, { extension: 'shell', error: message, context: 'web.tsx did not load' }),
  ).toBe(
    [
      'Extension `shell` failed: web.tsx did not load.',
      'Path: ~/.ultimate/extensions/shell (user)',
      `Error: ${message}`,
      'Build: b1 · gen 4',
    ].join('\n'),
  )
})

it("keeps a crash's own frames, capped", () => {
  const stack = Array.from({ length: 40 }, (_, line) =>
    line % 2
      ? `    at frame${line}`
      : '    at beginWork (/@fs/tmp/vite/deps/react-dom_client.js:1:1)',
  ).join('\n')
  const report = errorReport(system, {
    extension: 'shell',
    error: 'boom',
    context: 'a component threw',
    stack,
  })
  expect(report).toContain('Stack:\n```\nat frame1\n')
  expect(report).toContain('at frame15\n```')
  expect(report).not.toContain('frame17')
  expect(report).not.toContain('react-dom')
})

it('shortens Vite URLs in stack frames to paths', () => {
  const report = errorReport(system, {
    extension: 'shell',
    error: 'boom',
    context: 'a component threw',
    stack: [
      'at Crash (http://127.0.0.1:4747/@fs/home/me/.ultimate/extensions/shell/web.tsx?t=17:4:8)',
      'at Slot (http://127.0.0.1:4747/@fs/home/me/ultimate/web/src/compat/boundary.tsx:305:24)',
      'at ExtensionBoundary (http://127.0.0.1:4747/src/app/boundary.tsx?t=17:162:8)',
    ].join('\n'),
  })
  expect(report).toContain(
    [
      'at Crash (~/.ultimate/extensions/shell/web.tsx:4:8)',
      'at Slot (web/src/compat/boundary.tsx:305:24)',
      'at ExtensionBoundary (src/app/boundary.tsx:162:8)',
    ].join('\n'),
  )
})

it('leaves a multiline message out of the frames, so it cannot use up the cap', () => {
  const error = new Error(Array.from({ length: 10 }, (_, line) => `line ${line}`).join('\n'))
  const frames = stackFrames(error)
  expect(frames).toMatch(/^at /)
  expect(frames).not.toContain('line 9')
})
