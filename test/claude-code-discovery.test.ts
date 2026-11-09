import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { discoverClaudeModels, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { until } from './helpers.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — childExit() settles for a child that already
// exited (f697510). Discovery reads stdout to its end before awaiting the exit; when 'exit' came first (about 1 in 100
// launches through the process helper) it hung. Drop with the matching pnpm patch when upstream fixes this.
type Spawn = Parameters<typeof useSpawn>[0]

function fakeClaude() {
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
  const spawned: { env?: NodeJS.ProcessEnv }[] = []
  useSpawn(((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawned.push(options)
    return child
  }) as unknown as Spawn)
  return { stdin, stdout, child, spawned }
}

const env = {
  // Any executable passes the lookup; the injected spawn never starts it. Blank auth overrides a shell may set,
  // which discovery refuses.
  PI_CLAUDE_CODE_COMMAND: process.execPath,
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_BASE_URL: '',
}

// #542940: with either switch, Claude Code 2.1.321 answered from its built-in list (Fable 5.1) instead of the
// account's catalog (Fable 5.2), so the picker never offered the new model.
it('asks Claude Code for the account catalog, not its built-in list', async () => {
  const { stdin, stdout, child, spawned } = fakeClaude()
  const discovery = discoverClaudeModels({
    ...env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  })
  await until(() => stdin.readableLength > 0)
  expect(spawned[0].env).not.toHaveProperty('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  expect(spawned[0].env).not.toHaveProperty('DISABLE_TELEMETRY')
  // Exit without a catalog so discovery settles and never signals the fake pid.
  child.exitCode = 0
  child.emit('exit', 0, null)
  stdout.end()
  await expect(discovery).rejects.toThrow(/no selectable models/)
})

it('settles model discovery when Claude Code exits before its output ends', async () => {
  const { stdin, stdout, child } = fakeClaude()
  let settled = false
  const discovery = discoverClaudeModels(env).finally(() => (settled = true))
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
