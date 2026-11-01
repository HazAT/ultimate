/**
 * The process helper `lib/spawn.ts` forks: a small Node process that starts every child process on the host's behalf.
 * Starting a process forks the caller, which copies its page tables and blocks its main thread for tens of
 * milliseconds once it holds a gigabyte; this process stays small, so the copy is cheap. It exits with the host.
 */
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process'

export type Request =
  | { id: number; op: 'exec'; command: string; args: string[]; options: ExecFileOptions }
  | { id: number; op: 'spawn'; command: string; args: string[]; options: SpawnOptions }
  | { id: number; op: 'abort' }
  | { id: number; op: 'stdin'; data?: Uint8Array; end?: true }
  | { id: number; op: 'kill'; signal?: NodeJS.Signals | number }
  | { id: number; op: 'pause' | 'resume'; stream: 'stdout' | 'stderr' }

/** An error as plain data: its message, name and own fields (code, errno, killed, signal, cmd…). */
export type ErrorData = Record<string, unknown> & { message: string; name: string }

export type Reply =
  | { id: number; event: 'done'; stdout: string; stderr: string; error?: ErrorData }
  | { id: number; event: 'spawn'; pid: number }
  | { id: number; event: 'data'; stream: 'stdout' | 'stderr'; data: Uint8Array }
  | { id: number; event: 'end'; stream: 'stdout' | 'stderr' }
  | { id: number; event: 'error'; error: ErrorData }
  | { id: number; event: 'exit' | 'close'; code: number | null; signal: NodeJS.Signals | null }

const data = (error: Error): ErrorData => ({
  ...Object.fromEntries(Object.entries(error)),
  message: error.message,
  name: error.name,
})

function serve() {
  const send = (reply: Reply) => process.send!(reply)
  const aborts = new Map<number, AbortController>()
  const children = new Map<number, ChildProcess>()

  function exec({ id, command, args, options }: Extract<Request, { op: 'exec' }>) {
    const abort = new AbortController()
    aborts.set(id, abort)
    execFile(
      command,
      args,
      { ...options, encoding: 'utf8', signal: abort.signal },
      (error, stdout, stderr) => {
        aborts.delete(id)
        send({ id, event: 'done', stdout, stderr, ...(error && { error: data(error) }) })
      },
    )
  }

  function start({ id, command, args, options }: Extract<Request, { op: 'spawn' }>) {
    let child: ChildProcess
    try {
      child = spawn(command, args, options)
    } catch (error) {
      send({ id, event: 'error', error: data(error as Error) })
      send({ id, event: 'close', code: null, signal: null })
      return
    }
    children.set(id, child)
    child.once('spawn', () => send({ id, event: 'spawn', pid: child.pid! }))
    child.on('error', (error) => send({ id, event: 'error', error: data(error) }))
    child.once('exit', (code, signal) => send({ id, event: 'exit', code, signal }))
    child.once('close', (code, signal) => {
      children.delete(id)
      send({ id, event: 'close', code, signal })
    })
    child.stdin?.on('error', () => {
      // A child that exits before reading its input closes the pipe; its exit reports what happened.
    })
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = child[name]
      stream?.on('data', (chunk: Buffer) => send({ id, event: 'data', stream: name, data: chunk }))
      stream?.once('end', () => send({ id, event: 'end', stream: name }))
    }
  }

  process.on('message', (request: Request) => {
    const child = children.get(request.id)
    if (request.op === 'exec') exec(request)
    else if (request.op === 'spawn') start(request)
    else if (request.op === 'abort') aborts.get(request.id)?.abort()
    else if (request.op === 'kill') child?.kill(request.signal)
    else if (request.op === 'stdin') {
      if (request.data) child?.stdin?.write(request.data)
      if (request.end) child?.stdin?.end()
    } else child?.[request.stream]?.[request.op]()
  })
  // The host is gone: so is the reason to run. Its children carry on as they would have without a helper.
  process.on('disconnect', () => process.exit(0))
}

if (process.send) serve()
