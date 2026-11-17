import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { runClaudeRequest, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — the replay rewrite took messages[0] for the
// only leading user message. Claude Code 2.1.319 and newer put a "Called the Read tool" user message in front of it
// when the prompt mentions an existing path with "@", so the second request of such a conversation carried a system
// message between two user messages and the API refused it (#566809). Drop with the matching pnpm patch when
// upstream fixes this.
type Spawn = Parameters<typeof useSpawn>[0]
type Message = { role: string; content: unknown }

const text = (value: string) => ({ type: 'text', text: value })
const prompt = 'Ask @finance later.'
const called = '<system-reminder>\nCalled the Bash tool: ls finance\n</system-reminder>'
const listing = text(
  '<system-reminder>\nResult of calling the Bash tool:\nledger.txt\n</system-reminder>',
)
const account = text('<system-reminder>\n# userEmail\n</system-reminder>')
const environment = '# Environment\nlinux'
const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'mcp__pi__echo', input: {} }
const toolResult = {
  type: 'tool_result',
  tool_use_id: 'toolu_1',
  content: 'echoed',
  is_error: false,
}

// What Claude Code 2.1.322 sent for the two calls of the repro in #566809, shortened.
const requests: Message[][] = [
  [
    { role: 'user', content: called },
    { role: 'user', content: [listing, account, text(prompt)] },
    { role: 'system', content: [text(environment)] },
  ],
  [
    { role: 'user', content: called },
    { role: 'user', content: [listing, text(prompt)] },
    { role: 'system', content: environment },
    { role: 'assistant', content: [toolUse] },
    { role: 'user', content: [toolResult] },
    { role: 'system', content: [text(environment)] },
  ],
]

const answer = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { ...toolUse } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')

it('keeps system messages behind every leading user message Claude Code sends', async () => {
  const relayed: Message[][] = []
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    relayed.push(JSON.parse(body).messages)
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(answer)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  let started = 0
  let mentions: string | undefined
  useSpawn(((_command: string, args: string[], options: { env: Record<string, string> }) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      // No pid, ever: the provider ends a process with process.kill(-pid), and -1 is every process of the user (#562356).
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
    })
    const exit = (line: object) => {
      stdout.end(`${JSON.stringify(line)}\n`)
      stdout.once('end', () => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    }
    if (args.includes('status')) {
      exit({ loggedIn: true, subscriptionType: 'max' })
      return child
    }
    const messages = requests[started++]
    mentions = options.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS
    createInterface({ input: stdin }).on('line', (line) => {
      const frame = JSON.parse(line) as { type: string; shouldQuery?: boolean }
      if (frame.type !== 'user') return
      if (frame.shouldQuery === false) {
        stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', num_turns: 0 })}\n`)
        return
      }
      fetch(`${options.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ system: [text('Identity')], messages }),
      })
        .then((response) => response.text())
        .then(
          () => exit({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 1 }),
          (error) => child.emit('error', error),
        )
    })
    return child
  }) as unknown as Spawn)

  const user = {
    type: 'user' as const,
    message: { role: 'user' as const, content: [text(prompt)] },
  }
  const input = {
    model: 'claude-opus-5-5',
    systemPrompt: 'You help.',
    manifest: [],
    extraBody: {},
    upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    // Any executable passes the lookup; the injected spawn never starts it. Blank auth overrides a shell may set.
    env: {
      PI_CLAUDE_CODE_COMMAND: process.execPath,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
    },
  }
  try {
    const first = await runClaudeRequest({ ...input, frames: [user] })
    await runClaudeRequest({
      ...input,
      frames: [
        { ...user, shouldQuery: false },
        { type: 'assistant', message: { role: 'assistant', content: [toolUse] } },
        { type: 'user', message: { role: 'user', content: [toolResult] } },
      ],
      initialUserPrefix: first.initialUserPrefix,
      initialSystemMessages: first.initialSystemMessages,
    })
  } finally {
    upstream.close()
  }

  // Claude Code is told not to expand "@name" into a file's content or a folder listing at all.
  expect(mentions).toBe('1')
  const second = relayed[1]
  // The API's rule: a system message precedes an assistant message or ends the array.
  expect(second.map((message) => message.role)).toEqual([
    'user',
    'user',
    'system',
    'assistant',
    'user',
  ])
  expect(JSON.stringify(second).split('# Environment').length - 1).toBe(1)
  // The start of the request is the first request again, so its prompt cache still applies.
  const plain = (messages: Message[]) =>
    JSON.parse(
      JSON.stringify(messages, (key, value) => (key === 'cache_control' ? undefined : value)),
    )
  expect(plain(second.slice(1, 3))).toEqual(plain(relayed[0].slice(1, 3)))
})
