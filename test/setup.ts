import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { testTempPrefix } from './sweep-temp.ts'

// macOS's TMPDIR is a symlink (/var -> /private/var); git and the server report the resolved path.
const testTmpdir = realpathSync(mkdtempSync(join(tmpdir(), `${testTempPrefix}${process.pid}-`)))
const agentDir = mkdtempSync(join(testTmpdir, 'ultimate-test-pi-'))
process.env.PI_CODING_AGENT_DIR = agentDir
// Every boot would otherwise run the machine's real `claude auth status` (about 170 ms of CPU each); tests that need
// a Claude CLI stub their own.
process.env.PI_CLAUDE_CODE_COMMAND = join(testTmpdir, 'no-claude')
// Provider keys from the environment would make a configured model available, and summaries would prefer it over the
// scripted one: tests see only the logins they create.
for (const key of Object.keys(process.env))
  if (/_API_KEY$|_OAUTH_TOKEN$/.test(key)) delete process.env[key]
// Tests run without the supervisor's ULTIMATE_* variables: removed once for every file, not stubbed per test, so
// concurrent tests never see them come back. Inside a preview ULTIMATE_MODEL would otherwise override every model a test
// expects (#537493: test/default-model.test.ts, which imports no helpers, failed a preview's suite).
for (const key of Object.keys(process.env)) if (key.startsWith('ULTIMATE_')) delete process.env[key]
// Test servers, and the previews they start, must never publish on this machine's tailnet: they find no Tailscale CLI.
process.env.TAILSCALE_COMMAND = join(testTmpdir, 'no-tailscale')
// Instance startup sweeps must never inspect the machine's real preview homes during tests.
const previousTmpdir = process.env.TMPDIR
process.env.TMPDIR = testTmpdir

afterAll(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  rmSync(testTmpdir, { recursive: true, force: true })
})
