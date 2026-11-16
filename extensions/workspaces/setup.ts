import type { JsonObject } from '@earendil-works/pi-durable'
import { exec as execWithClosedInput } from '../../lib/exec.ts'

export type SetupRunner = (
  command: string,
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal; timeout: number },
) => Promise<void>

export async function setup(
  source: string,
  path: string,
  settings: JsonObject,
  signal: AbortSignal,
  run?: SetupRunner,
) {
  const commands =
    (settings as { isolates?: { worktree?: { setup?: string[] } } }).isolates?.worktree?.setup ?? []
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string'))
    throw new Error('isolates.worktree.setup must be an array of command strings')
  for (const command of commands) {
    signal.throwIfAborted()
    try {
      if (run)
        await run(command, { cwd: path, env: { ULTIMATE_SOURCE: source }, signal, timeout: 120000 })
      else
        await execWithClosedInput('sh', ['-c', command], {
          cwd: path,
          env: { ...process.env, ULTIMATE_SOURCE: source },
          signal,
          timeout: 120000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string }
      throw new Error(
        `Worktree setup failed: ${command}\n${`${output.stdout ?? ''}${output.stderr ?? ''}${output.message}`.slice(-4000)}`,
        { cause: error },
      )
    }
  }
}
