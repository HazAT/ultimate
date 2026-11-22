import { expect, it } from 'vitest'
import { rewriteInitialRequest } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { prepareNativeTranscript } from '@earendil-works/pi-claude-code/src/transcript.ts'
import type { NativeFrame } from '@earendil-works/pi-claude-code/src/native-types.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — replay must rebuild message cache breakpoints, not accumulate native/carrier markers. Drop with the matching pnpm patch when upstream fixes this.
const cache = { type: 'ephemeral', ttl: '1h' }
const text = (value: string, cached = false) => ({
  type: 'text',
  text: value,
  ...(cached ? { cache_control: cache } : {}),
})

function cachePaths(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'cache_control' ? [`${path}.${key}`] : cachePaths(child, `${path}.${key}`),
  )
}

function strip<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, child) => (key === 'cache_control' ? undefined : child)),
  )
}

/** Pi's history for a request: one user frame per user message, as Claude Code received it. */
function userFrames(messages: { role: string; content: unknown }[]): NativeFrame[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      type: 'user',
      message: { role: 'user', content: strip(message.content) as unknown[] },
    }))
}

const tools = prepareNativeTranscript(
  [
    {
      role: 'system',
      timestamp: 0,
      content: 'You are a coding assistant.',
      toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    },
  ],
  true,
)!.requestTools
const environment = [{ role: 'system', content: [text('<environment>repo</environment>', true)] }]

it('reproduces five accumulated breakpoints with native tools and three user messages', () => {
  const prefix = [text('<system-reminder>Repository context</system-reminder>', true)]
  const canonical = [text('Inspect the repo')]
  const payload = {
    tools,
    system: [text('Claude Code identity', true), text('Coding instructions', true)],
    messages: [
      { role: 'user', content: [...prefix, ...canonical] },
      ...environment,
      { role: 'assistant', content: [text('I inspected the repo.')] },
      { role: 'user', content: [text('Fix the issue')] },
      { role: 'assistant', content: [text('The fix is ready.')] },
      { role: 'user', content: [text('Now test it', true)] },
    ],
  }
  const frames = userFrames(payload.messages)
  frames[0].message.content = canonical
  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(payload)), frames, environment, []).toString(),
  )
  expect(cachePaths(rewritten)).toEqual([
    '.tools.0.cache_control',
    '.system.1.cache_control',
    '.messages.3.content.0.cache_control',
    '.messages.5.content.0.cache_control',
  ])
  // Cache normalization changes neither content nor tool definitions; Claude Code's reminder prefix is not Pi's history.
  payload.messages[0] = { role: 'user', content: canonical }
  expect(strip(rewritten)).toEqual(strip(payload))
  expect(
    JSON.parse(
      rewriteInitialRequest(
        Buffer.from(JSON.stringify(rewritten)),
        frames,
        environment,
        [],
      ).toString(),
    ),
  ).toEqual(rewritten)
})

it.each([false, true])('normalizes all replay markers with native injections=%s', (native) => {
  const toolInput = { path: 'README.md', cache_control: 'ordinary tool argument' }
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    cache_control: cache,
  }
  const payload = {
    tools,
    system: [text('Identity', true), text('Instructions', true)],
    messages: [
      { role: 'user', content: [text('Inspect', true)] },
      ...environment,
      {
        role: 'assistant',
        content: [
          text('Reading the file', true),
          { type: 'tool_use', id: 'read-1', name: 'mcp__pi__read', input: toolInput },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-1',
            content: [text('file contents', true), image],
            cache_control: cache,
          },
        ],
      },
      { role: 'assistant', content: [text('Checked', true)] },
      { role: 'user', content: [text('Compare this image'), image] },
    ],
  }
  const injections = native
    ? [{ beforeAssistant: null, content: [text('Updated instructions', true)] }]
    : undefined
  const rewritten = JSON.parse(
    rewriteInitialRequest(
      Buffer.from(JSON.stringify(payload)),
      userFrames(payload.messages),
      environment,
      injections,
    ).toString(),
  )
  // An input key named cache_control is tool data, not a cache breakpoint.
  expect(rewritten.messages[2].content[1].input).toEqual(toolInput)
  const counted = structuredClone(rewritten)
  delete counted.messages[2].content[1].input.cache_control
  expect(cachePaths(counted)).toEqual([
    '.tools.0.cache_control',
    '.system.1.cache_control',
    '.messages.3.content.0.cache_control',
    native ? '.messages.6.content.0.cache_control' : '.messages.5.content.1.cache_control',
  ])
  expect(rewritten.messages[3].content[0].content).toEqual([
    text('file contents'),
    { ...image, cache_control: undefined },
  ])
  expect(rewritten.messages[5].content[1].source).toEqual(image.source)
})

it.each([1, 2])('keeps environment and final boundaries for %s user messages', (users) => {
  const messages = [
    { role: 'user', content: [text('Inspect', true)] },
    ...environment,
    { role: 'system', content: [text('Extra environment', true)] },
    ...(users === 2
      ? [
          { role: 'assistant', content: [text('Inspected', true)] },
          { role: 'user', content: [text('Continue', true)] },
        ]
      : []),
  ]
  const rewritten = JSON.parse(
    rewriteInitialRequest(
      Buffer.from(
        JSON.stringify({
          tools,
          system: [text('Identity', true), text('Instructions', true)],
          messages,
        }),
      ),
      userFrames(messages),
      undefined,
      [],
    ).toString(),
  )
  expect(cachePaths(rewritten)).toEqual([
    '.tools.0.cache_control',
    '.system.1.cache_control',
    '.messages.1.content.0.cache_control',
    users === 2 ? '.messages.4.content.0.cache_control' : '.messages.2.content.0.cache_control',
  ])
})
