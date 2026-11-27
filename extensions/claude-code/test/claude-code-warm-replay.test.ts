import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import {
  closeClaudeProcesses,
  runClaudeRequest,
  useSpawn,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import type { NativeFrame } from '@earendil-works/pi-claude-code/src/native-types.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — a warm process does not continue after an
// answer without visible text. Drop with the matching pnpm patch when upstream fixes this.
type Spawn = Parameters<typeof useSpawn>[0]
type Fake = EventEmitter & { exitCode: number | null; frames: NativeFrame[] }
const children: Fake[] = []

function fakeClaudeCode(answers: unknown[][]) {
  useSpawn(((_command: string, args: string[]) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      // No real pid: cleanup must never signal a process group from a fake child.
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
      frames: [] as NativeFrame[],
    })
    const send = (line: object) => stdout.write(`${JSON.stringify(line)}\n`)
    if (args.includes('status')) {
      stdout.end(`${JSON.stringify({ loggedIn: true, subscriptionType: 'max' })}\n`)
      stdout.once('end', () => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return child
    }
    children.push(child)
    // Without a pid the provider kills a child once it emits 'spawn'; this child exits at that point instead.
    child.on('newListener', (event) => {
      if (event !== 'spawn') return
      queueMicrotask(() => {
        stdout.end()
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    })
    createInterface({ input: stdin }).on('line', (line) => {
      const frame = JSON.parse(line) as NativeFrame & { uuid: string }
      child.frames.push(frame)
      if (frame.type !== 'user') return
      if (frame.shouldQuery === false) {
        send({ type: 'result', subtype: 'success', num_turns: 0 })
        return
      }
      const usage = { input_tokens: 1, output_tokens: 1 }
      send({
        type: 'assistant',
        message: { role: 'assistant', content: answers.shift(), stop_reason: 'end_turn', usage },
      })
      send({ type: 'stream_event', event: { type: 'message_stop' } })
      send({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage,
        user_message_uuids: [frame.uuid],
      })
    })
    return child
  }) as unknown as Spawn)
}

afterEach(async () => {
  await closeClaudeProcesses()
  children.length = 0
})

const user = (text: string): NativeFrame => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const request = (frames: NativeFrame[]) =>
  runClaudeRequest({
    model: 'claude-opus-5-5',
    systemPrompt: 'You help.',
    manifest: [],
    extraBody: {},
    frames,
    sessionId: 'session-1',
    env: {
      PI_CLAUDE_CODE_COMMAND: process.execPath,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
    },
  })

// poe2-rust #20166: a coordinator's answer was signed thinking alone. Its warm Claude Code process then added
// "[Your previous response had no visible output. Please continue…]" to the next user message of its own history and
// sent 92 user messages where Pi's history had 93, so the replay rewrite failed and every retry hit the same process.
it('replays from Pi after an answer with only thinking instead of continuing the warm process', async () => {
  const thinking = { type: 'thinking', thinking: 'Both look okay.', signature: 'c2ln' }
  fakeClaudeCode([[thinking], [{ type: 'text', text: 'Fixing it.' }]])
  const first = await request([user('Start the reviewer')])
  expect(first.message.content).toEqual([thinking])

  const history = [
    { ...user('Start the reviewer'), shouldQuery: false as const },
    { type: 'assistant' as const, message: { role: 'assistant' as const, content: [thinking] } },
    user('[subagent answered] NEEDS CHANGES'),
  ]
  const second = await request(history)
  expect(second.message.content).toEqual([{ type: 'text', text: 'Fixing it.' }])
  expect(children).toHaveLength(2)
  expect(children[1].frames.map((frame) => frame.type)).toEqual(['user', 'assistant', 'user'])
})
