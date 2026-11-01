/**
 * Starting child processes from a small helper process (`spawn-helper.ts`) instead of this one. Node starts a process
 * with fork(), which copies the caller's page tables on its main thread: about 30–50 ms per launch once the host holds
 * a gigabyte or more outside V8's heap, against well under a millisecond for a message to the helper.
 *
 * One helper serves the whole process, forked on first use and again after it exits; a launch running when it exits
 * fails. Its protocol is fixed for the life of the helper, so a change to this file or the helper needs a restart.
 */
import { fork } from 'node:child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ErrorData, Reply, Request } from './spawn-helper.ts'

type Handler = (reply: Reply) => void

interface Helper {
  process?: ChildProcess
  next: number
  handlers: Map<number, Handler>
}

// Shared by every copy of this module in the process (the server's and each extension loader's), so there is one helper.
const helper: Helper = ((globalThis as Record<symbol, Helper>)[
  Symbol.for('ultimate.spawn-helper')
] ??= { next: 1, handlers: new Map() })

const gone = (): ErrorData => ({ name: 'Error', message: 'The process helper exited' })

/**
 * Fail every launch `child` was running, once: it exited, or its channel broke (then it is killed, so a new one takes
 * over). The launches are detached first, so one that a failure starts again goes to the next helper.
 */
function lost(child: ChildProcess) {
  if (helper.process !== child) return
  helper.process = undefined
  child.kill('SIGKILL')
  const failed = helper.handlers
  helper.handlers = new Map()
  for (const [id, handle] of failed) {
    handle({ id, event: 'error', error: gone() })
    handle({ id, event: 'written', error: gone() })
    handle({ id, event: 'done', stdout: '', stderr: '', error: gone() })
    handle({ id, event: 'close', code: null, signal: null })
  }
}

function connect() {
  if (helper.process) return helper.process
  const child = fork(fileURLToPath(new URL('./spawn-helper.ts', import.meta.url)), [], {
    execArgv: [],
    serialization: 'advanced',
  })
  child.unref()
  child.channel?.unref()
  child.on('message', (reply: Reply) => helper.handlers.get(reply.id)?.(reply))
  child.on('error', () => lost(child))
  child.once('exit', () => lost(child))
  child.once('disconnect', () => lost(child))
  helper.process = child
  return child
}

/** Send to the helper; a send that fails means its channel broke, which fails all its launches. */
function post(child: ChildProcess, message: Request) {
  child.send(message, (error: Error | null) => {
    if (error) lost(child)
  })
}

/** Send a request, registering `handle` for its replies; the helper keeps this process alive only while one runs. */
type Unsent<R> = R extends unknown ? Omit<R, 'id'> : never

function request(message: Unsent<Request>, handle: Handler) {
  const child = connect()
  const id = helper.next++
  helper.handlers.set(id, handle)
  child.channel?.ref()
  post(child, { ...message, id })
  return id
}

function settle(id: number) {
  helper.handlers.delete(id)
  if (helper.handlers.size === 0) helper.process?.channel?.unref()
}

function send(message: Request) {
  // A helper that already exited has failed the request; nothing is left to tell it.
  if (helper.handlers.has(message.id) && helper.process) post(helper.process, message)
}

/** The options the helper gets: what a launch from this process would inherit made explicit, and no AbortSignal. */
const carried = <T extends ExecFileOptions | SpawnOptions>(options: T) => ({
  ...options,
  cwd: options.cwd ?? process.cwd(),
  env: { ...(options.env ?? process.env) },
})

const revive = ({ name, message, ...fields }: ErrorData) =>
  Object.assign(new Error(message), { name }, fields)

/**
 * `child_process.execFile` as a promise, like `util.promisify(execFile)`: resolves `{ stdout, stderr }` as text and
 * rejects with execFile's error, stdout and stderr attached. A `signal` aborts the run.
 */
export function execFile(
  command: string,
  args: readonly string[] = [],
  { signal, ...options }: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = request(
      { op: 'exec', command, args: [...args], options: carried(options) },
      (reply) => {
        if (reply.event !== 'done') return
        settle(id)
        signal?.removeEventListener('abort', abort)
        const { stdout, stderr, error } = reply
        if (error) reject(Object.assign(revive(error), { stdout, stderr }))
        else resolve({ stdout, stderr })
      },
    )
    const abort = () => send({ id, op: 'abort' })
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Which of stdin, stdout and stderr are pipes for `stdio`; the helper refuses streams, descriptors and 'ipc'. */
function pipes(stdio: SpawnOptions['stdio'] = 'pipe') {
  const each = typeof stdio === 'string' ? [stdio, stdio, stdio] : stdio
  if (
    each.length > 3 ||
    each.some((one) => (one != null && typeof one !== 'string') || one === 'ipc')
  )
    throw new TypeError('spawn through the process helper takes only pipe, ignore or inherit')
  return [0, 1, 2].map((fd) => (each[fd] ?? 'pipe') === 'pipe' || each[fd] === 'overlapped')
}

/**
 * `child_process.spawn`, started by the helper: the returned object behaves like a ChildProcess with piped stdio, a
 * `kill`, and `exitCode`/`signalCode`. `pid` is known from its 'spawn' event on, not right away.
 */
export const spawn = ((
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess => {
  const [stdin, stdout, stderr] = pipes(options.stdio)
  const { signal, ...rest } = options
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    killed: boolean
    stdin: Writable | null
    stdout: Readable | null
    stderr: Readable | null
    kill(signal?: NodeJS.Signals | number): boolean
  }
  // The helper pauses a stream whose reader here is behind, and resumes it once the reader asks for more.
  const paused = { stdout: false, stderr: false }
  const ended = { stdout: false, stderr: false }
  const end = (stream: 'stdout' | 'stderr') => {
    if (ended[stream]) return
    ended[stream] = true
    child[stream]?.push(null)
  }
  // A write to the child's input finishes when the helper reports the child took it: one at a time, as Writable does.
  let writing: ((error?: Error | null) => void) | undefined
  const write = (message: Extract<Request, { op: 'stdin' }>, done: typeof writing) => {
    writing = done
    send(message)
  }
  const output = (stream: 'stdout' | 'stderr') =>
    new Readable({
      read() {
        if (!paused[stream]) return
        paused[stream] = false
        send({ id, op: 'resume', stream })
      },
    })
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: stdin
      ? new Writable({
          write: (data: Buffer, _encoding, done) => write({ id, op: 'stdin', data }, done),
          final: (done) => write({ id, op: 'stdin', end: true }, done),
        })
      : null,
    stdout: stdout ? output('stdout') : null,
    stderr: stderr ? output('stderr') : null,
    kill(name: NodeJS.Signals | number = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return false
      child.killed = true
      send({ id, op: 'kill', signal: name })
      return true
    },
  })
  const id = request({ op: 'spawn', command, args: [...args], options: carried(rest) }, (reply) => {
    if (reply.event === 'spawn') {
      child.pid = reply.pid
      child.emit('spawn')
    } else if (reply.event === 'data') {
      const stream = child[reply.stream]
      if (stream && !stream.destroyed && !stream.push(Buffer.from(reply.data))) {
        paused[reply.stream] = true
        send({ id, op: 'pause', stream: reply.stream })
      }
    } else if (reply.event === 'end') end(reply.stream)
    else if (reply.event === 'written') {
      const done = writing
      writing = undefined
      done?.(reply.error && revive(reply.error))
    } else if (reply.event === 'error') child.emit('error', revive(reply.error))
    else if (reply.event === 'exit') {
      child.exitCode ??= reply.code
      child.signalCode ??= reply.signal
      child.emit('exit', reply.code, reply.signal)
    } else if (reply.event === 'close') {
      settle(id)
      child.exitCode ??= reply.code
      child.signalCode ??= reply.signal
      closed(reply.code, reply.signal)
    }
  })
  /**
   * Emit 'close' as Node does: after the output streams ended here, so a reader that stops at 'close' has had every
   * byte. Output with no reader at all is drained, as Node's flushStdio does at exit.
   */
  function closed(code: number | null, exitSignal: NodeJS.Signals | null) {
    if (!child.stdin?.writableFinished) child.stdin?.destroy()
    const open = (['stdout', 'stderr'] as const).filter((name) => child[name]?.closed === false)
    let left = open.length
    const one = () => --left <= 0 && child.emit('close', code, exitSignal)
    if (!left) one()
    for (const name of open) {
      const stream = child[name]!
      stream.once('close', one)
      // The helper sent every chunk before its close; one it never ended (a lost helper) ends here.
      end(name)
      if (stream.readableFlowing === null) stream.resume()
    }
  }
  if (signal) {
    const abort = () => child.kill(options.killSignal)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
  }
  return child as unknown as ChildProcess
}) as typeof import('node:child_process').spawn
