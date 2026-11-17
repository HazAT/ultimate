import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { incompleteResponseError, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import {
  createClaudeCodeProvider,
  streamClaudeCode,
} from '@earendil-works/pi-claude-code/src/index.ts'
import { normalizeError } from '@earendil-works/pi-claude-code/src/stream.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — a response that ends without a result of
// Claude Code's own must be retryable by pi-ai, and an error Claude Code reports itself must be the stated reason.
// Drop with the matching pnpm patch when upstream fixes this.
type Spawn = Parameters<typeof useSpawn>[0]
const warning =
  '[claude-code:unrecognized_model] {"model":"claude-fable-5-2","query_source":"sdk"}\n'

it('retries a Claude Code stream that ends without a result, whatever stderr holds', () => {
  for (const stderr of ['', warning]) {
    // The stream stores normalizeError(thrown) as errorMessage; the retry check reads only these two fields.
    const message = {
      stopReason: 'error',
      errorMessage: normalizeError(incompleteResponseError(stderr)),
    } as AssistantMessage
    expect(message.errorMessage).toMatch(/^Incomplete Claude Code response: stream ended without/)
    expect(isRetryableAssistantError(message)).toBe(true)
  }
})

// #562356: Claude Code 2.1.319 did not know claude-fable-5-2, assumed a 200k window and, in a warm process above
// about 190k tokens, refused the turn itself without a request. The provider reported the process's start-up stderr
// warning as the reason ("Incomplete Claude Code response: … ([claude-code:unrecognized_model] …)"), which is neither
// an overflow nor retryable, so the run failed with a misleading card.
it("reports Claude Code's own refusal of a turn, not its stderr warning", async () => {
  useSpawn(((_command: string, args: string[]) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      // No pid, ever: the provider closes a turn's process with process.kill(-pid), and -1 is every process of the
      // user. A fake `pid: 1` here ended the desktop session while this test was written (#562356).
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
    })
    const exit = (...lines: object[]) => {
      stdout.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
      stdout.once('end', () => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    }
    if (args.includes('status')) exit({ loggedIn: true, subscriptionType: 'max' })
    else
      stdin.once('data', () => {
        stderr.write(warning)
        // What 2.1.319 wrote, shortened: no stream events, a synthetic assistant error and an error result.
        exit(
          {
            type: 'assistant',
            message: {
              model: '<synthetic>',
              role: 'assistant',
              stop_reason: 'stop_sequence',
              content: [{ type: 'text', text: 'Prompt is too long' }],
            },
            error: 'invalid_request',
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            num_turns: 1,
            terminal_reason: 'blocking_limit',
          },
        )
      })
    return child
  }) as unknown as Spawn)

  const model = createClaudeCodeProvider().getModels()[0]
  const stream = streamClaudeCode(
    model,
    normalizeContext({
      messages: [
        { role: 'system', content: 'You help.', timestamp: 0 },
        { role: 'user', content: 'Say ok.', timestamp: 0 },
      ],
    }),
    {
      // Any executable passes the lookup; the injected spawn never starts it. Blank auth overrides a shell may set.
      env: {
        PI_CLAUDE_CODE_COMMAND: process.execPath,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
      },
    },
  )
  const message = await stream.result()
  expect(message.errorMessage).toBe(
    'context_length_exceeded: Claude Code request failed: Prompt is too long',
  )
  // Pi compacts on an overflow instead of retrying it.
  expect(isContextOverflow(message)).toBe(true)
})
