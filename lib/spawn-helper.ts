import { spawn } from 'node:child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process'
import { isNoProcess } from './errors.ts'
import { deadline } from './timers.ts'

export type Request =
  | { id: number; op: 'exec'; command: string; args: string[]; options: ExecFileOptions }
  | { id: number; op: 'spawn'; command: string; args: string[]; options: SpawnOptions }
  | { id: number; op: 'abort' }
  | { id: number; op: 'stdin'; data?: Uint8Array; end?: true }
  | { id: number; op: 'kill'; signal?: NodeJS.Signals | number }
  | { id: number; op: 'pause' | 'resume' | 'destroy'; stream: 'stdout' | 'stderr' }

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

function signalGroup(child: ChildProcess, name?: NodeJS.Signals | number) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, name)
  } catch (error) {
    if (!isNoProcess(error)) child.emit('error', error)
  }
}

function serve() {
  const send = (reply: Reply) =>
    process.send!(reply, (closedHostChannel: Error | null) => {
      void closedHostChannel
    })
  const aborts = new Map<number, () => void>()
  const children = new Map<number, ChildProcess>()

  function startInOwnGroup(id: number, command: string, args: string[], options: SpawnOptions) {
    const child = spawn(command, args, { ...options, detached: true })
    children.set(id, child)
    child.once('close', () => children.delete(id))
    return child
  }

  function exec({ id, command, args, options }: Extract<Request, { op: 'exec' }>) {
    const { timeout = 0, killSignal = 'SIGTERM', maxBuffer = 1024 * 1024, ...rest } = options
    const output = { stdout: '', stderr: '' }
    let failure: Error | undefined
    let killed = false
    let child: ChildProcess | undefined
    let cancelTimeout = () => {}
    const finish = (code: number | null = null, signal: NodeJS.Signals | null = null) => {
      if (!aborts.delete(id)) return
      cancelTimeout()
      const cmd = [command, ...args].join(' ')
      const error =
        failure ??
        (code === 0 && signal === null
          ? undefined
          : Object.assign(new Error(`Command failed: ${cmd}\n${output.stderr}`), {
              code,
              killed,
              signal,
            }))
      send({
        id,
        event: 'done',
        ...output,
        ...(error && { error: data(Object.assign(error, { cmd })) }),
      })
    }
    const fail = (error: Error) => {
      failure = error
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      finish()
    }
    const kill = () => {
      killed = true
      child!.stdout?.destroy()
      child!.stderr?.destroy()
      signalGroup(child!, killSignal)
    }
    aborts.set(id, () => {
      signalGroup(child!, killSignal)
      fail(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        }),
      )
    })
    try {
      child = startInOwnGroup(id, command, args, rest)
    } catch (error) {
      fail(error as Error)
      return
    }
    child.on('error', fail)
    child.once('close', finish)
    child.stdin?.end()
    for (const name of ['stdout', 'stderr'] as const) {
      let bytes = 0
      child[name]?.setEncoding('utf8').on('data', (chunk: string) => {
        const before = bytes
        bytes += Buffer.byteLength(chunk)
        if (bytes <= maxBuffer) output[name] += chunk
        else {
          output[name] += chunk.slice(0, maxBuffer - before)
          failure = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          })
          kill()
        }
      })
    }
    if (timeout > 0) cancelTimeout = deadline(timeout, kill)
  }

  function start({ id, command, args, options }: Extract<Request, { op: 'spawn' }>) {
    let child: ChildProcess
    try {
      child = startInOwnGroup(id, command, args, options)
    } catch (error) {
      send({ id, event: 'error', error: data(error as Error) })
      send({ id, event: 'close', code: null, signal: null })
      return
    }
    child.once('spawn', () => send({ id, event: 'spawn', pid: child.pid! }))
    child.on('error', (error) => send({ id, event: 'error', error: data(error) }))
    child.once('exit', (code, signal) => send({ id, event: 'exit', code, signal }))
    child.once('close', (code, signal) => send({ id, event: 'close', code, signal }))
    child.stdin?.on('error', () => {})
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = child[name]
      stream?.on('data', (chunk: Buffer) => send({ id, event: 'data', stream: name, data: chunk }))
      stream?.once('end', () => send({ id, event: 'end', stream: name }))
    }
  }

  function writeInputWithReceipt({ id, data: chunk, end }: Extract<Request, { op: 'stdin' }>) {
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
    else if (request.op === 'stdin') writeInputWithReceipt(request)
    else if (request.op === 'abort') aborts.get(request.id)?.()
    else if (request.op === 'kill') {
      if (child) signalGroup(child, request.signal)
    } else child?.[request.stream]?.[request.op]()
  })
  const killEveryGroupThenExitWhenHostGone = () => {
    for (const child of children.values()) signalGroup(child, 'SIGKILL')
    process.exit(0)
  }
  process.on('disconnect', killEveryGroupThenExitWhenHostGone)
  const stopOnlyWithTheHostThroughDisconnect = () => {}
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(name, stopOnlyWithTheHostThroughDisconnect)
}

if (process.send) serve()
