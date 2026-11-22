import { createServer as createHttpServer } from 'node:http'
import { webAliases } from '../lib/web-alias.ts'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import type { ViteDevServer } from 'vite-plus'
import { createApi, Events } from './api.ts'
import { loadExtensions } from './extensions.ts'
import type { Watch } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions, OpenHost } from './harness.ts'
import { createSystem } from './system.ts'
import { emit } from './events.ts'
import { StartedEvent } from '../shared/events.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ChildMessage, SupervisorMessage } from './supervisor-protocol.ts'

import { alive } from '../lib/lock.ts'
import { inProcess } from '../lib/errors.ts'
import { every } from '../lib/timers.ts'
import { realpath } from 'node:fs/promises'
import { extensionModules } from './vite-extensions.ts'
import { createWeb } from './web.ts'
import { admit, createAccess } from './request-security.ts'
import { writeProject } from './project.ts'
import { reportCore } from './supervisor-protocol.ts'
import { viteLogger } from './vite-logger.ts'
import type { Notice } from '../shared/protocol.ts'

const send = (message: ChildMessage) => process.send?.(message)

const loopbackPreviewFrameAncestors =
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:*"

export interface ServerOptions extends HostOptions {
  port?: number
  publicUrl?: string
}
export async function prepareServer(options: Partial<ServerOptions> = {}) {
  const ultimateRoot =
    options.ultimateRoot ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
  const projectRoot = await realpath(
    options.projectRoot ?? process.env.ULTIMATE_PROJECT ?? options.ultimateRoot ?? process.cwd(),
  )
  const events = new Events()
  const notice = (entry: Notice) => {
    events.emit('notice', entry)
    reportCore({
      type: 'log',
      level: entry.level === 'warning' ? 'warn' : entry.level,
      source: 'core',
      text: entry.message,
    })
  }
  const host = await prepareHarness({
    ...options,
    ultimateRoot,
    projectRoot,
    report: notice,
  })
  let system: Awaited<ReturnType<typeof createSystem>> | undefined
  let reportedRemoteOrigins: string[] = []
  const access = createAccess(() => {
    const origins = access.origins()
    for (const origin of origins)
      if (!reportedRemoteOrigins.includes(origin)) console.log(`Ultimate: ${origin} (remote)`)
    for (const origin of reportedRemoteOrigins)
      if (!origins.includes(origin)) console.log(`Ultimate: ${origin} (remote) is no longer served`)
    reportedRemoteOrigins = origins
    reportCore({ type: 'access', origins })
    void system
      ?.changed()
      .catch((error: unknown) => console.error('Publishing access changes failed:', error))
  })
  let api: Awaited<ReturnType<typeof createApi>> | undefined
  let web: Awaited<ReturnType<typeof createWeb>> | undefined
  const http = createHttpServer((request, response) => {
    inProcess(
      'a request handler: the HTTP response dies with the process',
      (async () => {
        const port =
          new URL(
            options.publicUrl ??
              `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`,
          ).port || '80'
        if (!(await admit(request, port, access.rules))) {
          response.writeHead(403)
          response.end('Forbidden')
          return
        }
        if (!api) {
          response.writeHead(503)
          response.end('Preparing')
          return
        }
        response.setHeader('Content-Security-Policy', loopbackPreviewFrameAncestors)
        if (await api.handle(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405)
          response.end()
          return
        }
        await web!.handle(request, response)
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end('Internal server error')
      }),
    )
  })
  const restarted = new Set<(watcher: ViteDevServer['watcher']) => void>()
  reportCore({ type: 'web', state: 'preparing' })
  const vite = await createViteServer({
    customLogger: viteLogger(),
    clearScreen: false,
    configFile: resolvePath(ultimateRoot, 'vite.config.ts'),
    root: resolvePath(ultimateRoot, 'web'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: resolvePath(host.home, 'vite'),
    resolve: { alias: webAliases(ultimateRoot) },
    plugins: [
      extensionModules(ultimateRoot, projectRoot, host.userHome),
      {
        name: 'ultimate:watchers',
        configureServer: (server) => {
          for (const move of restarted) move(server.watcher)
        },
      },
    ],
  })
  const restartViteOnConfigChangeWithoutHmr = (file: string) => {
    if (file === vite.config.configFile)
      inProcess(
        'the Vite server belongs to this process',
        vite.restart().catch((error: unknown) => console.error('Restarting Vite failed:', error)),
      )
  }
  const watch: Watch = (attach) => {
    let detach = attach(vite.watcher)
    const move = (watcher: ViteDevServer['watcher']) => {
      detach()
      detach = attach(watcher)
    }
    restarted.add(move)
    return () => {
      restarted.delete(move)
      detach()
    }
  }
  watch((watcher) => {
    watcher.on('change', restartViteOnConfigChangeWithoutHmr)
    return () => watcher.off('change', restartViteOnConfigChangeWithoutHmr)
  })
  let opened: OpenHost | undefined
  const processInfo: { activationError?: string } = {}
  let settledGoOrRelease = Promise.resolve()
  const serial = <T>(task: () => Promise<T>) => {
    const next = settledGoOrRelease.then(task)
    settledGoOrRelease = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const extensions = await loadExtensions(
    vite,
    host,
    () => system?.changed(),
    {
      access,
      harness: () => {
        if (!opened) throw new Error('Harness is not open')
        return opened.harness
      },
      system: () => {
        if (!system) throw new Error('System is not ready')
        return system.current()
      },
      conversations: () => api?.conversations() ?? [],
    },
    watch,
    (message) => notice({ level: 'warning', message }),
    () => web!.rebuild(),
  )
  web = await createWeb({
    ultimateRoot,
    projectRoot,
    userHome: host.userHome,
    home: host.home,
    watch,
    before: () => extensions.prepareLoadBestEffort(),
    pages: () => api?.pages() ?? 0,
    changed: () => void system?.changed(),
    notice: (message) => notice({ level: 'error', message }),
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? Number(process.env.ULTIMATE_PORT ?? 4747), '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  const url = options.publicUrl ?? `http://127.0.0.1:${address.port}`
  system = await createSystem(
    host,
    watch,
    url,
    extensions.info,
    (info) => events.emit('system', info),
    (message) => notice({ level: 'error', message }),
    processInfo,
    access.origins,
    () => web.info(),
  )
  const openExtensionsThenServeApi = async (harness: OpenHost) => {
    opened = harness
    await harness.harness.commit(
      (tx) =>
        emit(tx, StartedEvent, {
          generation: Number(process.env.ULTIMATE_GENERATION ?? 1),
          build: host.build().id,
        }),
      context,
    )
    await extensions.opened()
    await system.changed()
    api = await createApi(host, harness, events, system, extensions, access, () =>
      web.pageConnected(),
    )
    harness.harness.resume()
    return { ...harness, api, system }
  }
  return {
    http,
    vite,
    host,
    extensions,
    events,
    url,
    port: address.port,
    web,
    release: () =>
      serial(async () => {
        if (opened) await extensions.released()
        await api?.close()
        api = undefined
        http.closeAllConnections()
        await opened?.close()
        opened = undefined
        reportCore({ type: 'web', state: 'stopped' })
      }),
    go: (activationError?: string) =>
      serial(async () => {
        processInfo.activationError = activationError
        await writeProject(host.home, host.projectRoot)
        const served = await openExtensionsThenServeApi(await host.open(false))
        reportCore({ type: 'web', state: 'ready' })
        return served
      }),
    async close() {
      const stopped = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      if (opened) await extensions.released()
      await api?.close()
      await opened?.close()
      opened = undefined
      await extensions.close()
      await web?.close()
      await system?.close()
      await vite.close()
      reportCore({ type: 'web', state: 'stopped' })
      http.closeAllConnections()
      await stopped
    },
  }
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const prepared = await prepareServer(options)
  const opened = await prepared.go()
  return { ...prepared, ...opened, close: () => prepared.close() }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.ULTIMATE_INSTANCE_OWNER) {
    const owner = Number(process.env.ULTIMATE_INSTANCE_OWNER)
    if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Invalid instance owner')
    every(
      500,
      () => {
        if (!alive(owner)) process.exit(0)
      },
      { unref: true },
    )
  }
  let server: Awaited<ReturnType<typeof prepareServer>> | undefined
  let sharedTeardown: Promise<void> | undefined
  const close = () => (sharedTeardown ??= Promise.resolve(server?.close()))
  const shutdown = () => {
    inProcess(
      'shutdown only closes this process',
      close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('Server shutdown failed:', error)
          process.exit(1)
        },
      ),
    )
  }
  if (process.env.ULTIMATE_SUPERVISED === '1' && process.send) {
    const refuse = (signal: NodeJS.Signals) =>
      reportCore({
        type: 'log',
        level: 'warn',
        source: 'core',
        text: `Ignored ${signal} sent to core pid ${process.pid}: the supervisor stops its core itself. Either Ultimate is stopping through its service (the signal went to the whole group), or a process outside it killed by port or name`,
      })
    process.on('SIGINT', refuse)
    process.on('SIGTERM', refuse)
    try {
      server = await prepareServer({ port: 0, publicUrl: process.env.ULTIMATE_PUBLIC_URL })
      process.on('message', (message: SupervisorMessage) => {
        inProcess(
          'the supervisor message controls this process lifecycle',
          (async () => {
            if (message.type === 'go' || message.type === 'reacquire') {
              await server!.go(message.type === 'reacquire' ? message.error : undefined)
              send({ type: 'ready' })
            }
            if (message.type === 'release') {
              await server!.release()
              send({ type: 'released' })
            }
            if (message.type === 'exit') {
              await close()
              process.exit(0)
            }
          })().catch((error) => {
            send({ type: 'failed', error: String(error) })
            console.error(error)
            process.exit(1)
          }),
        )
      })
      process.on('disconnect', shutdown)
      send({ type: 'prepared', port: server.port })
    } catch (error) {
      send({ type: 'failed', error: String(error) })
      console.error(error)
      process.exit(1)
    }
  } else {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    server = await prepareServer()
    await server.go()
    console.log(`Ultimate: ${server.url}`)
  }
}
