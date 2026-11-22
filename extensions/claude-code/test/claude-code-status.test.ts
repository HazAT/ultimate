import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { getClaudeStatus, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — `claude auth status` prints the account's email.
// Upstream put the tail of an unparsable stdout into the status detail, which reaches a turn's error message and so the
// model. The patch reports stderr only, and reads only a boolean loggedIn as an answer. Drop with the matching pnpm
// patch when upstream does both.
type Spawn = Parameters<typeof useSpawn>[0]

function answer(stdout: string) {
  useSpawn((() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      // No pid: the provider ends a process with process.kill(-pid), and -1 is every process of the user (#562356).
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
    })
    child.stderr.end('')
    child.stdout.end(stdout)
    child.stdout.once('end', () => {
      child.exitCode = 1
      child.emit('close', 1, null)
      child.emit('exit', 1, null)
    })
    return child
  }) as unknown as Spawn)
}

const env = { PI_CLAUDE_CODE_COMMAND: process.execPath }

it('keeps the account email out of an unreadable status', async () => {
  answer('{"loggedIn": true, "email": "private@example.test", "subscri')
  const status = await getClaudeStatus(env)
  expect(status).toMatchObject({ loggedIn: false, diagnostic: true })
  expect(status.detail).not.toContain('private@example.test')
})

it('reads a status without a boolean loggedIn as no answer', async () => {
  answer('{}')
  expect(await getClaudeStatus(env)).toMatchObject({ loggedIn: false, diagnostic: true })
})
