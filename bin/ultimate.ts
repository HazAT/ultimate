#!/usr/bin/env node
import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { projectHome } from '../lib/project-paths.ts'
import { acquireLock, readOwner, retireStorageOwner } from '../lib/lock.ts'
import { deadline, pace } from '../lib/timers.shared.ts'
import { watch, existsSync, readdirSync, readFileSync } from 'node:fs'
import { closeOnWatchError } from '../lib/watch.ts'
import { homedir } from 'node:os'
import { watchRoots } from '../server/watch-roots.ts'
import { join, resolve as resolvePath } from 'node:path'
import { createServer, connect } from 'node:net'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from '../shared/protocol.ts'
import type { ChildMessage, SupervisorMessage } from '../server/supervisor-protocol.ts'
import { loopbackAuthority, proxied } from '../server/request-security.ts'
import { isCoreReport } from '../server/supervisor-protocol.ts'
import type { CoreReport } from '../server/supervisor-protocol.ts'
import { dashboard } from './dashboard.ts'

const ultimateRoot = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const usage = `Usage: ultimate [dir] [--port N] [--no-open]

Starts Ultimate for the project in dir (default: the current directory), or opens a window of it when it already runs.

  --port N     serve on port N (default: ULTIMATE_PORT, the project's settings port, or the first free from 4747)
  --no-open    do not open a window (also ULTIMATE_NO_OPEN=1)
  -h, --help   print this help`
function usageError(message: string): never {
  console.error(`${message}\n\n${usage}`)
  process.exit(1)
}
const { values, positionals } = (() => {
  try {
    return parseArgs({
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    })
  } catch (error) {
    return usageError((error as Error).message)
  }
})()
if (values.help) {
  console.log(usage)
  process.exit(0)
}
if (positionals.length > 1) usageError('Expected at most one project directory')
const opening = !values['no-open'] && process.env.ULTIMATE_NO_OPEN !== '1'
const available = (name: string) =>
  process.env.PATH?.split(':').some((path) => existsSync(join(path, name)))
function installedChromeApp(app: string) {
  const apps = join(homedir(), 'Applications/Chrome Apps.localized')
  const value = (text: string, key: string) =>
    text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]
  try {
    const plist = readdirSync(apps)
      .filter((bundle) => bundle.endsWith('.app'))
      .map((bundle) => readFileSync(join(apps, bundle, 'Contents/Info.plist'), 'utf8'))
      .find((text) => value(text, 'CrAppModeShortcutURL')?.startsWith(`${app}/`))
    return plist && value(plist, 'CrAppModeShortcutID')
  } catch {
    return undefined
  }
}
function openWindow(port: number) {
  const app = `http://ultimate.localhost:${port}`
  const tab = `http://127.0.0.1:${port}`
  let command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  let args = [tab]
  if (process.platform === 'darwin') {
    if (existsSync('/Applications/Google Chrome.app')) {
      const id = installedChromeApp(app)
      args = ['-na', 'Google Chrome', '--args', id ? `--app-id=${id}` : `--app=${app}`]
    }
  } else if (available('omarchy-launch-webapp')) {
    command = 'omarchy-launch-webapp'
    args = [app]
  } else {
    const browser = [
      'google-chrome-stable',
      'google-chrome',
      'chromium',
      'chromium-browser',
      'brave',
      'brave-browser',
      'microsoft-edge',
      'vivaldi',
    ].find(available)
    if (browser) {
      command = browser
      args = [`--app=${app}`]
    }
  }
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' })
  opener.on('error', (error) => console.error(`Cannot open ${tab}: ${error.message}`))
  opener.unref()
}
const projectRoot = await realpath(positionals[0] ?? process.cwd()).catch((error) => {
  console.error(
    `Cannot open project ${positionals[0] ?? process.cwd()}: ${error.code ?? error.message}`,
  )
  process.exit(1)
})
const home = process.env.ULTIMATE_HOME ?? projectHome(projectRoot)
function settingsPort() {
  let settings: { port?: unknown }
  try {
    settings = JSON.parse(readFileSync(join(projectRoot, '.ultimate/settings.json'), 'utf8'))
  } catch {
    return undefined
  }
  return settings?.port === undefined ? undefined : JSON.stringify(settings.port)
}
const requestedPort = values.port ?? process.env.ULTIMATE_PORT ?? settingsPort()
let port = Number(requestedPort ?? 4747)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
const lockPath = join(home, 'ultimate.lock')
await mkdir(home, { recursive: true })
const lock = await acquireLock(lockPath, {
  pid: process.pid,
  port,
  project: projectRoot,
}).catch(async (error) => {
  const runningProjectToReopen = opening && (await readOwner(lockPath))
  if (
    runningProjectToReopen &&
    runningProjectToReopen.port !== undefined &&
    String(error).includes('already running')
  ) {
    openWindow(runningProjectToReopen.port)
    process.exit(0)
  }
  console.error(String(error))
  process.exit(1)
})
const resetOrRestoreInterrupted = existsSync(join(home, 'reset.json'))
if (resetOrRestoreInterrupted) {
  await lock.close()
  console.error(
    `A reset or restore of ${home} was interrupted. Rerun \`pnpm reset ${projectRoot}\` or \`pnpm restore --dir ${projectRoot}\`, then start Ultimate.`,
  )
  process.exit(1)
}
if (lock.stale) {
  try {
    await retireStorageOwner(join(home, 'storage.lock'))
  } catch (error) {
    await lock.close()
    throw error
  }
}
const display = dashboard(join(home, 'supervisor.log'))
process.on('exit', () => display.close())
let active: Core | undefined
let swapping = false
let stopping = false
let crashPage = false
let failures = 0
const stableAfterMs = 60000
let generation = 0
let announced = false
let stderr = ''
const pending = new Set<Socket>()
const sockets = new Set<Socket>()
const children = new Set<Core>()
const tail = (text: string) => text.split('\n').slice(-200).join('\n')
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function route(socket: Socket) {
  if (socket.destroyed) return
  if (active) {
    const upstream = connect(active.port, '127.0.0.1')
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
    socket.resume()
  } else if (crashPage) {
    let head = ''
    const expired = () => socket.destroy()
    socket.setTimeout(5000, expired)
    const receive = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      if (active || !crashPage) {
        socket.pause()
        socket.off('data', receive)
        socket.off('timeout', expired)
        socket.setTimeout(0)
        socket.unshift(Buffer.from(head, 'latin1'))
        route(socket)
        return
      }
      if (!head.includes('\r\n\r\n') && head.length < 16384) return
      socket.off('data', receive)
      socket.off('timeout', expired)
      socket.setTimeout(0)
      const headers: Record<string, string> = {}
      for (const line of head.split('\r\n').slice(1)) {
        if (!line) break
        const colon = line.indexOf(':')
        if (colon > 0)
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const direct =
        head.length < 16384 &&
        !proxied(headers) &&
        loopbackAuthority(headers.host, String(publicPort))
      const html = direct
        ? `<h1>Ultimate core could not boot</h1><p>Waiting for changes in server/, shared/, extensions/</p><pre>${escape(stderr)}</pre>`
        : ''
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`,
      )
    }
    socket.on('data', receive)
    socket.resume()
  } else {
    socket.pause()
    pending.add(socket)
  }
}
function flush() {
  for (const socket of pending) route(socket)
  pending.clear()
}
const proxy = createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => {
    sockets.delete(socket)
    pending.delete(socket)
  })
  route(socket)
})
try {
  await new Promise<void>((resolve, reject) => {
    const listen = () => {
      proxy.once('error', failed)
      proxy.listen(port, '127.0.0.1', () => {
        proxy.off('error', failed)
        resolve()
      })
    }
    const failed = (error: NodeJS.ErrnoException) => {
      if (!requestedPort && error.code === 'EADDRINUSE' && port < 65535) {
        port++
        listen()
      } else reject(error)
    }
    listen()
  })
} catch (error) {
  await lock.close()
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${port} is in use; free it or start with --port N.`)
    process.exit(1)
  }
  throw error
}
const address = proxy.address()
if (!address || typeof address === 'string') throw new Error('No proxy address')
const publicPort = address.port
const publicUrl = `http://127.0.0.1:${publicPort}`
await lock.update({ pid: process.pid, port: address.port, project: projectRoot })
display.url(publicUrl)

type Core = {
  child: ChildProcess
  port: number
  generation: number
  readyAt?: number
  stderr: string
  messages: ChildMessage[]
  reports: Map<'web' | 'access', CoreReport>
}
function wait(
  core: Core,
  type: ChildMessage['type'],
  requestId?: string,
  timeout = 60000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: ChildMessage) => {
      cancel()
      core.child.off('message', check)
      core.child.off('exit', exited)
      if (error) reject(error)
      else resolve(message!)
    }
    const check = () => {
      const index = core.messages.findIndex(
        (m) => m.type === type && (!requestId || ('requestId' in m && m.requestId === requestId)),
      )
      const failed = core.messages.find((m) => m.type === 'failed')
      if (failed?.type === 'failed') finish(new Error(failed.error))
      else if (index !== -1) finish(undefined, core.messages.splice(index, 1)[0])
    }
    const exited = () => finish(new Error(`Core exited before ${type}: ${core.stderr}`))
    const cancel = deadline(timeout, () =>
      finish(new Error(`Timed out waiting for ${type}: ${core.stderr}`)),
    )
    core.child.on('message', check)
    core.child.once('exit', exited)
    check()
    if (core.child.exitCode !== null || core.child.signalCode !== null) exited()
  })
}
function send(core: Core, message: SupervisorMessage) {
  if (core.child.connected) core.child.send(message, () => {})
}
async function kill(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const exited = once(core.child, 'exit')
  core.child.kill('SIGKILL')
  await exited
}
async function exit(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const expiresAt = Date.now() + 10000
  try {
    const released = wait(core, 'released', undefined, 10000)
    send(core, { type: 'release' })
    await released
    const exited = once(core.child, 'exit')
    send(core, { type: 'exit' })
    await Promise.race([exited, pace(Math.max(0, expiresAt - Date.now()))])
  } catch {
    await kill(core)
    return
  }
  await kill(core)
}
function boot(previousBuild?: BuildInfo): Core {
  const child = fork(join(ultimateRoot, 'server/main.ts'), [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIMALLOC_ALLOW_THP: '0',
      ULTIMATE_HOME: home,
      ULTIMATE_PROJECT: projectRoot,
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_GENERATION: String(++generation),
      ULTIMATE_PUBLIC_URL: publicUrl,
      ...(previousBuild ? { ULTIMATE_PREVIOUS_BUILD: JSON.stringify(previousBuild) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const core: Core = { child, generation, port: 0, stderr: '', messages: [], reports: new Map() }
  display.lifecycle('preparing', { generation, pid: child.pid })
  children.add(core)
  child.stdout?.on('data', (chunk) => display.log('info', `core ${core.generation}`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    core.stderr = tail(core.stderr + chunk)
    stderr = tail(stderr + chunk)
    display.log('warn', `core ${core.generation}`, String(chunk))
  })
  child.on('error', (error) => {
    core.messages.push({ type: 'failed', error: String(error) })
  })
  child.on('message', (message: ChildMessage) => {
    if (isCoreReport(message)) {
      if (message.type === 'log') {
        display.log(message.level, `${message.source} · core ${core.generation}`, message.text)
      } else {
        core.reports.set(message.type, message)
        if (core === active) display.report(message)
      }
      return
    }
    if (message.type === 'swap') {
      if (core === active)
        void swap(core, message.requestId, message.build).catch((error: unknown) =>
          display.log('error', 'supervisor', `Core swap failed: ${String(error)}`),
        )
      return
    }
    core.messages.push(message)
  })
  child.on('exit', () => {
    children.delete(core)
    if (core === active && !swapping && !stopping) {
      active = undefined
      failures = Date.now() - core.readyAt! < stableAfterMs ? failures + 1 : 0
      display.lifecycle('crashed')
      display.log('error', 'supervisor', `Core ${core.generation} exited unexpectedly`)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
    }
  })
  return core
}
async function checkTypes() {
  display.lifecycle(
    'checking',
    active ? { generation: active.generation, pid: active.child.pid } : undefined,
  )
  const child = spawn(
    join(ultimateRoot, 'node_modules/.bin/tsc'),
    ['--noEmit', '-p', 'tsconfig.swap.json'],
    { cwd: ultimateRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output = tail(output + data)
    display.log('info', 'typecheck', String(data))
  })
  child.stderr.on('data', (data) => {
    output = tail(output + data)
    display.log('warn', 'typecheck', String(data))
  })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(output || `Type check exited ${code}`)
}
async function prepare(core: Core) {
  const message = await wait(core, 'prepared')
  if (message.type === 'prepared') core.port = message.port
}
async function start(core: Core) {
  send(core, { type: 'go' })
  await wait(core, 'ready')
  if (stopping) {
    await kill(core)
    return
  }
  active = core
  core.readyAt = Date.now()
  display.lifecycle('ready', { generation: core.generation, pid: core.child.pid })
  for (const report of core.reports.values()) display.report(report)
  crashPage = false
  flush()
  if (!announced) {
    announced = true
    display.log('info', 'supervisor', `Ultimate: ${publicUrl}`)
    if (opening) openWindow(publicPort)
  }
}
async function swap(old: Core, requestId: string, previousBuild?: BuildInfo) {
  if (swapping) {
    send(old, {
      type: 'swap-result',
      requestId,
      ok: false,
      error: 'A core swap is already in progress.',
    })
    return
  }
  swapping = true
  let next: Core | undefined
  let released = false
  try {
    await checkTypes()
    next = boot(previousBuild)
    await prepare(next)
    const ack = wait(old, 'swap-ack', requestId)
    send(old, { type: 'swap-result', requestId, ok: true, generation: next.generation })
    const acknowledgement = await ack
    if (acknowledgement.type === 'swap-ack' && !acknowledgement.ok)
      throw new Error(acknowledgement.error ?? 'Restart memo failed')
    active = undefined
    display.lifecycle('swapping')
    released = true
    const release = wait(old, 'released', undefined, 10000)
    send(old, { type: 'release' })
    await release
    await start(next)
    await exit(old)
  } catch (error) {
    if (next) await kill(next)
    stderr = tail(String(error) + '\n' + (next?.stderr ?? ''))
    display.log('error', 'supervisor', stderr)
    if (!released && old.child.connected)
      send(old, { type: 'swap-result', requestId, ok: false, error: stderr })
    else {
      old.messages = old.messages.filter((message) => message.type !== 'failed')
      send(old, { type: 'reacquire', error: stderr })
      try {
        await wait(old, 'ready')
        active = old
        display.lifecycle('ready', { generation: old.generation, pid: old.child.pid })
        for (const report of old.reports.values()) display.report(report)
        flush()
      } catch {
        await kill(old)
        active = undefined
      }
    }
  } finally {
    swapping = false
    if (active && (active.child.exitCode !== null || active.child.signalCode !== null))
      active = undefined
    if (active) {
      display.lifecycle('ready', { generation: active.generation, pid: active.child.pid })
      for (const report of active.reports.values()) display.report(report)
    }
    if (!active && !stopping)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
  }
}
let recovering = false
async function recover() {
  if (recovering || stopping) return
  recovering = true
  try {
    while (!active && failures < 3) {
      display.lifecycle(failures ? 'recovering' : 'starting')
      await pace(500 * 2 ** failures)
      if (stopping) break
      let core: Core | undefined
      try {
        core = boot()
        await prepare(core)
        await start(core)
      } catch (error) {
        if (core) await kill(core)
        stderr = tail(String(error) + '\n' + (core?.stderr ?? ''))
        display.log('error', 'supervisor', stderr)
        failures++
      }
    }
    if (!active && !stopping) {
      crashPage = true
      display.lifecycle('failed · waiting for changes')
      flush()
    }
  } finally {
    recovering = false
  }
}
const retry = () => {
  if (crashPage && !recovering && !stopping) {
    failures = 0
    crashPage = false
    void recover().catch((error: unknown) =>
      display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
    )
  }
}
function watchForRetry(directory: string) {
  const watcher = watch(directory, { recursive: true }, retry)
  return closeOnWatchError(watcher, directory, (message, error) => {
    display.log('error', 'supervisor', `${message} ${String(error)}`)
  })
}
const watchers = ['server', 'shared', 'extensions'].map((directory) =>
  watchForRetry(join(ultimateRoot, directory)),
)
const projectConfig = join(projectRoot, '.ultimate')
let configWatcher: ReturnType<typeof watch> | undefined
const watchConfig = () => {
  configWatcher?.close()
  configWatcher = watchForRetry(projectConfig)
  retry()
}
if (existsSync(projectConfig)) watchConfig()
const stopRoots = watchRoots([projectConfig], watchConfig)
async function shutdown() {
  if (stopping) return
  stopping = true
  display.lifecycle('stopping')
  stopRoots()
  configWatcher?.close()
  for (const watcher of watchers) watcher.close()
  for (const socket of sockets) socket.destroy()
  proxy.close()
  await Promise.all([...children].map(exit))
  await lock.close()
  display.lifecycle('stopped')
  display.close()
  process.exit(0)
}
const stop = () => {
  void shutdown().catch((error: unknown) => {
    display.log('error', 'supervisor', `Shutdown failed: ${String(error)}`)
    process.exit(1)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await recover()
