import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { discoverClaudeModels, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { until } from './helpers.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — childExit() settles for a child that already
// exited (f697510). Discovery reads stdout to its end before awaiting the exit; when 'exit' came first (about 1 in 100
// launches through the process helper) it hung. Drop with the matching pnpm patch when upstream fixes this.
it('settles model discovery when Claude Code exits before its output ends', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: 1,
    exitCode: null as number | null,
    signalCode: null,
  })
  type Spawn = Parameters<typeof useSpawn>[0]
  useSpawn((() => child as unknown as ReturnType<Spawn>) as unknown as Spawn)

  let settled = false
  const discovery = discoverClaudeModels({
    // Any executable passes the lookup; the injected spawn never starts it. Blank auth overrides a shell may set,
    // which discovery refuses.
    PI_CLAUDE_CODE_COMMAND: process.execPath,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
  }).finally(() => (settled = true))
  await until(() => stdin.readableLength > 0)
  const [initialize] = String(stdin.read()).split('\n')
  const requestId = JSON.parse(initialize).request_id as string

  child.exitCode = 0
  child.emit('exit', 0, null)
  stdout.end(
    `${JSON.stringify({
      type: 'control_response',
      response: {
        request_id: requestId,
        subtype: 'success',
        response: { models: [{ value: 'default', displayName: 'Default', description: 'd' }] },
      },
    })}\n`,
  )

  await until(() => settled, 2000)
  await expect(discovery).resolves.toEqual([
    { value: 'default', displayName: 'Default', description: 'd' },
  ])
})
