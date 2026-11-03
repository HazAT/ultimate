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
  | { id: number; op: 'pause' | 'resume' | 'destroy'; stream: 'stdout' | 'stderr' }

/** An error as plain data: its message, name and own fields (code, errno, killed, signal, cmd…). */
export type ErrorData = Record<string, unknown> & { message: string; name: string }

export type Reply =
  | { id: number; event: 'done'; stdout: string; stderr: string; error?: ErrorData }
  | { id: number; event: 'spawn'; pid: number }
  | { id: number; event: 'data'; stream: 'stdout' | 'stderr'; data: Uint8Array }
  | { id: number; event: 'end'; stream: 'stdout' | 'stderr' }
  | { id: number; event: 'written'; error?: ErrorData }
  | { id: number; event: 'error'; error: ErrorData }
  | { id: number; event: 'exit' | 'close'; code: number | null; signal: NodeJS.Signals | null }

const data = (error: Error): ErrorData => ({
  ...Object.fromEntries(Object.entries(error)),
  message: error.message,
  name: error.name,
})

function serve() {
  const send = (reply: Reply) =>
    process.send!(reply, (error: Error | null) => {
      // Only a closed channel fails a send: the host is gone, and 'disconnect' below ends this process.
      void error
    })
  const aborts = new Map<number, AbortController>()
  const children = new Map<number, ChildProcess>()

  function exec({ id, command, args, options }: Extract<Request, { op: 'exec' }>) {
    const abort = new AbortController()
    aborts.set(id, abort)
    const done = (error: Error | null, stdout = '', stderr = '') => {
      aborts.delete(id)
      send({ id, event: 'done', stdout, stderr, ...(error && { error: data(error) }) })
    }
    try {
      const child = execFile(
        command,
        args,
        { ...options, encoding: 'utf8', signal: abort.signal },
        done,
      )
      // Nothing writes to an exec's input: a program that reads it gets EOF, not a wait forever.
      child.stdin?.end()
    } catch (error) {
      done(error as Error)
    }
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
      // A child that exits before reading its input closes the pipe; the failed write reports it to the host.
    })
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = child[name]
      stream?.on('data', (chunk: Buffer) => send({ id, event: 'data', stream: name, data: chunk }))
      stream?.once('end', () => send({ id, event: 'end', stream: name }))
    }
  }

  /**
   * Write to a child's input; the host writes its next chunk only once this one was taken, or failed. Every chunk was
   * already taken, so closing it is done once asked, as `end()` on a ChildProcess's own stdin is: Node destroys the
   * input of a child that exits, which fails an end still under way, but the input is closed all the same.
   */
  function input({ id, data: chunk, end }: Extract<Request, { op: 'stdin' }>) {
    const stdin = children.get(id)?.stdin
    const written = (error?: Error | null) =>
      send({ id, event: 'written', ...(error && { error: data(error) }) })
    if (!stdin) written(new Error('The process has no input open'))
    else if (end) {
      stdin.end()
      written()
    } else stdin.write(chunk!, written)
  }

  process.on('message', (request: Request) => {
    const child = children.get(request.id)
    if (request.op === 'exec') exec(request)
    else if (request.op === 'spawn') start(request)
    else if (request.op === 'stdin') input(request)
    else if (request.op === 'abort') aborts.get(request.id)?.abort()
    else if (request.op === 'kill') child?.kill(request.signal)
    else child?.[request.stream]?.[request.op]()
  })
  // The host is gone: so is the reason to run. Its children carry on as they would have without a helper.
  process.on('disconnect', () => process.exit(0))
}

if (process.send) serve()
