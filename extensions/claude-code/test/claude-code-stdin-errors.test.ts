import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { runClaudeRequest, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { until } from '../../../test/helpers.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — drain waits remove their error listeners,
// and turn stdin absorbs errors even without a pending drain. Drop with the patch when upstream fixes this.
type Spawn = Parameters<typeof useSpawn>[0]

function fakeTurn(backpressure: boolean, count: number) {
  let writes = 0
  const stdin = new Writable({
    highWaterMark: backpressure ? 1 : 1024 * 1024,
    write(_chunk, _encoding, callback) {
      writes++
      queueMicrotask(callback)
    },
  })
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    // No real pid: cleanup must never signal a process group from a fake child.
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
  })
  useSpawn(((_command: string, args: string[]) => {
    if (!args.includes('status')) return child
    const authOutput = new PassThrough()
    const auth = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: authOutput,
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
    })
    authOutput.end(`${JSON.stringify({ loggedIn: true, subscriptionType: 'max' })}\n`)
    authOutput.once('end', () => {
      auth.exitCode = 0
      auth.emit('exit', 0, null)
    })
    return auth
  }) as unknown as Spawn)
  const result = runClaudeRequest({
    model: 'claude-opus-5-5',
    systemPrompt: 'You help.',
    manifest: [],
    extraBody: {},
    frames: Array.from({ length: count }, () => ({
      type: 'user' as const,
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
    })),
    env: {
      PI_CLAUDE_CODE_COMMAND: process.execPath,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
    },
  })
  return {
    stdin,
    ready: () => writes === count && !stdin.writableNeedDrain && stdin.listenerCount('drain') === 0,
    async finish() {
      child.exitCode = 1
      child.emit('exit', 1, null)
      stdout.end()
      await expect(result).rejects.toThrow(/Claude Code exited/)
    },
  }
}

it('does not retain error listeners after twelve backpressured frames drain', async () => {
  const turn = fakeTurn(true, 12)
  try {
    await until(turn.ready)
    expect(turn.stdin.listenerCount('error')).toBeLessThanOrEqual(1)
  } finally {
    await turn.finish()
  }
})

it('absorbs a stdin write failure when no drain is pending', async () => {
  const turn = fakeTurn(false, 1)
  try {
    await until(turn.ready)
    expect(() => turn.stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
  } finally {
    await turn.finish()
  }
})
