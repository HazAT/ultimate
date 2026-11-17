import { fork } from 'node:child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ErrorData, Reply, Request } from './spawn-helper.ts'

type Handler = (reply: Reply) => void

type ChildWithPidOnlyAfterSpawnEvent = EventEmitter & {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  killed: boolean
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
}

interface ProcessWideFixedProtocolHelper {
  process?: ChildProcess
  next: number
  handlers: Map<number, Handler>
}

const helper: ProcessWideFixedProtocolHelper = ((
  globalThis as Record<symbol, ProcessWideFixedProtocolHelper>
)[Symbol.for('ultimate.spawn-helper')] ??= { next: 1, handlers: new Map() })

const gone = (): ErrorData => ({ name: 'Error', message: 'The process helper exited' })

function lost(child: ChildProcess) {
  if (helper.process !== child) return
  helper.process = undefined
  child.kill('SIGKILL')
  const detachedBeforeRetry = helper.handlers
  helper.handlers = new Map()
  for (const [id, handle] of detachedBeforeRetry) {
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

function post(child: ChildProcess, message: Request) {
  child.send(message, (error: Error | null) => {
    if (error) lost(child)
  })
}

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
  if (helper.handlers.has(message.id) && helper.process) post(helper.process, message)
}

const explicitCallerEnvironment = <T extends ExecFileOptions | SpawnOptions>(options: T) => ({
  ...options,
  cwd: options.cwd ?? process.cwd(),
  env: { ...(options.env ?? process.env) },
})

const revive = ({ name, message, ...fields }: ErrorData) =>
  Object.assign(new Error(message), { name }, fields)

export function execFile(
  command: string,
  args: readonly string[] = [],
  { signal, ...options }: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = request(
      { op: 'exec', command, args: [...args], options: explicitCallerEnvironment(options) },
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

function pipes(stdio: SpawnOptions['stdio'] = 'pipe') {
  const each = typeof stdio === 'string' ? [stdio, stdio, stdio] : stdio
  if (
    each.length > 3 ||
    each.some((one) => (one != null && typeof one !== 'string') || one === 'ipc')
  )
    throw new TypeError('spawn through the process helper takes only pipe, ignore or inherit')
  return [0, 1, 2].map((fd) => (each[fd] ?? 'pipe') === 'pipe' || each[fd] === 'overlapped')
}

export const spawn = ((
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess => {
  const [stdin, stdout, stderr] = pipes(options.stdio)
  const { signal, ...rest } = options
  const child = new EventEmitter() as ChildWithPidOnlyAfterSpawnEvent
  const pausedForReaderBackpressure = { stdout: false, stderr: false }
  const ended = { stdout: false, stderr: false }
  const endOutputOnce = (stream: 'stdout' | 'stderr') => {
    if (ended[stream]) return
    ended[stream] = true
    child[stream]?.push(null)
  }
  let awaitingInputReceipt: ((error?: Error | null) => void) | undefined
  const write = (message: Extract<Request, { op: 'stdin' }>, done: typeof awaitingInputReceipt) => {
    awaitingInputReceipt = done
    send(message)
  }
  const output = (stream: 'stdout' | 'stderr') =>
    new Readable({
      read() {
        if (!pausedForReaderBackpressure[stream]) return
        pausedForReaderBackpressure[stream] = false
        send({ id, op: 'resume', stream })
      },
      destroy(error, done) {
        if (!ended[stream]) send({ id, op: 'destroy', stream })
        done(error)
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
  const drainUnreadOutput = (stream: Readable | null) => {
    if (stream?.readableFlowing === null) stream.resume()
  }
  const id = request(
    { op: 'spawn', command, args: [...args], options: explicitCallerEnvironment(rest) },
    (reply) => {
      if (reply.event === 'spawn') {
        child.pid = reply.pid
        child.emit('spawn')
      } else if (reply.event === 'data') {
        const stream = child[reply.stream]
        if (stream && !stream.destroyed && !stream.push(Buffer.from(reply.data))) {
          pausedForReaderBackpressure[reply.stream] = true
          send({ id, op: 'pause', stream: reply.stream })
        }
      } else if (reply.event === 'end') endOutputOnce(reply.stream)
      else if (reply.event === 'written') {
        const done = awaitingInputReceipt
        awaitingInputReceipt = undefined
        done?.(reply.error && revive(reply.error))
      } else if (reply.event === 'error') child.emit('error', revive(reply.error))
      else if (reply.event === 'exit') {
        child.exitCode ??= reply.code
        child.signalCode ??= reply.signal
        child.emit('exit', reply.code, reply.signal)
        for (const stream of [child.stdout, child.stderr]) drainUnreadOutput(stream)
      } else if (reply.event === 'close') {
        settle(id)
        child.exitCode ??= reply.code
        child.signalCode ??= reply.signal
        closeAfterAllOutputDelivered(reply.code, reply.signal)
      }
    },
  )
  function closeAfterAllOutputDelivered(code: number | null, exitSignal: NodeJS.Signals | null) {
    if (!child.stdin?.writableFinished) child.stdin?.destroy()
    const streamsStillOpenAfterHelperClose = (['stdout', 'stderr'] as const).filter(
      (name) => child[name]?.closed === false,
    )
    let left = streamsStillOpenAfterHelperClose.length
    const one = () => --left <= 0 && child.emit('close', code, exitSignal)
    if (!left) one()
    for (const name of streamsStillOpenAfterHelperClose) {
      const stream = child[name]!
      stream.once('close', one)
      endOutputOnce(name)
      drainUnreadOutput(stream)
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
