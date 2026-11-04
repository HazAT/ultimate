/**
 * The web UI, served as a production bundle. `web-build.ts` builds it in a process of its own, into
 * `<home>/web/<id>/`, when a page asks for it and it is stale; while a page is open, a change to its sources rebuilds
 * it at once and the page reloads onto it (`system.web.id`). A facet that fails to build is left out with its error,
 * so its card shows the error and the rest runs; any other failure keeps the previous bundle and raises a notice.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { exec } from '../lib/exec.ts'
import { discoverExtensions } from './discovery.ts'
import { discoveryRoots } from './project.ts'
import { extensionSettingsFiles } from './extension-settings.ts'
import type { Watch } from './extensions.ts'
import { watchRoots } from './watch-roots.ts'
import type { WebBuildRequest, WebBuildResult } from './web-build.ts'

interface Manifest {
  id: string
  /** When the build started: a source changed after it makes the bundle stale. */
  at: number
  inputs: string[]
  facets: string[]
  /** Folders of facets left out because they did not build: any change in one may fix it. */
  broken: string[]
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** The enabled web facets' `web.tsx` paths, as the bundle's loader map keys them. */
export async function webFacets(ultimateRoot: string, projectRoot: string, userHome: string) {
  return (await discoverExtensions(ultimateRoot, projectRoot, userHome))
    .filter((entry) => entry.enabled && entry.files.includes('web.tsx'))
    .map((entry) => join(entry.path, 'web.tsx'))
}

export async function createWeb(options: {
  ultimateRoot: string
  projectRoot: string
  userHome: string
  home: string
  watch: Watch
  /** Open browser pages: with none, a change only marks the bundle stale. */
  pages: () => number
  /** A new bundle is current. */
  changed: () => void
  notice: (message: string) => void
}) {
  const { ultimateRoot, projectRoot, userHome } = options
  const folder = join(options.home, 'web')
  const roots = discoveryRoots(ultimateRoot, projectRoot, userHome).map((root) =>
    join(root.path, 'extensions'),
  )
  const settings = [
    ...extensionSettingsFiles(projectRoot, userHome),
    join(userHome, '.ultimate/trust.json'),
  ]
  const webRoot = join(ultimateRoot, 'web')
  const always = [
    join(ultimateRoot, 'vite.config.ts'),
    join(ultimateRoot, 'pnpm-lock.yaml'),
    ...settings,
  ]
  let manifest = await readFile(join(folder, 'manifest.json'), 'utf8').then(
    (text) => JSON.parse(text) as Manifest,
    () => undefined, // No bundle yet: the first page builds one.
  )
  let inputs = new Set(manifest?.inputs)
  let brokenRoots = manifest?.broken ?? []
  let previous: string | undefined
  let stale = !manifest || !(await fresh(manifest))
  let building: Promise<void> | undefined
  let changedFiles: string[] = []
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function fresh(current: Manifest) {
    const facets = await webFacets(ultimateRoot, projectRoot, userHome)
    // A broken facet may have been fixed while the host was down: try it again.
    if (current.broken?.length || facets.join('\0') !== current.facets.join('\0')) return false
    const times = await Promise.all(
      current.inputs.map((file) =>
        stat(file).then(
          (info) => info.mtimeMs,
          () => Number.POSITIVE_INFINITY, // A missing source changed.
        ),
      ),
    )
    return times.every((time) => time <= current.at)
  }

  async function buildOnce() {
    const at = Date.now()
    const facets = await webFacets(ultimateRoot, projectRoot, userHome)
    const targets = await discoverExtensions(ultimateRoot, projectRoot, userHome)
    const outDir = join(folder, 'next')
    const broken: Record<string, string> = {}
    const brokenFolders: string[] = []
    let result: WebBuildResult
    for (;;) {
      const request: WebBuildRequest = {
        ultimateRoot,
        projectRoot,
        userHome,
        outDir,
        cacheDir: join(options.home, 'vite'),
        broken,
      }
      const { stdout } = await exec(
        process.execPath,
        [fileURLToPath(new URL('./web-build.ts', import.meta.url)), JSON.stringify(request)],
        // The server's Vite set NODE_ENV to development; inherited, the bundle would ship React's development build.
        {
          cwd: ultimateRoot,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, NODE_ENV: 'production' },
        },
      )
      result = JSON.parse(stdout.trim().split('\n').at(-1)!) as WebBuildResult
      if ('inputs' in result) break
      const file = result.error.file
      const facet =
        file &&
        targets.find(
          (entry) => entry.files.includes('web.tsx') && file.startsWith(entry.target + sep),
        )
      if (!facet || facet.name in broken) {
        options.notice(
          `The web UI did not build${file ? ` (${relative(ultimateRoot, file)})` : ''}: ${result.error.message}`,
        )
        return
      }
      broken[facet.name] = result.error.message
      brokenFolders.push(facet.target)
      options.notice(`${join(facet.path, 'web.tsx')} did not build: ${result.error.message}`)
    }
    // Asset names carry their content hash: a facet's own chunk changes without the entry or index.html changing.
    const assets = (await readdir(outDir, { recursive: true })).toSorted()
    const id = createHash('sha256')
      .update(await readFile(join(outDir, 'index.html')))
      .update(assets.join('\0'))
      .digest('hex')
      .slice(0, 12)
    const target = join(folder, id)
    await rm(target, { recursive: true, force: true })
    await rename(outDir, target)
    const publicFiles = (
      await readdir(join(webRoot, 'public'), { recursive: true }).catch(() => [])
    ) // No public files.
      .map((file) => join(webRoot, 'public', file))
    const next: Manifest = {
      id,
      at,
      inputs: [
        ...new Set([
          ...result.inputs.filter((file) => !file.includes('/node_modules/')),
          ...always,
          join(webRoot, 'index.html'),
          ...publicFiles,
        ]),
      ],
      facets,
      broken: brokenFolders,
    }
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(next))
    if (manifest?.id !== id) {
      previous = manifest?.id
      // The current bundle and the one before it: a page still on the old one may load a chunk while it switches.
      for (const name of await readdir(folder))
        if (![id, previous, 'manifest.json'].includes(name))
          await rm(join(folder, name), { recursive: true, force: true })
    }
    const switched = manifest?.id !== id
    manifest = next
    inputs = new Set(next.inputs)
    brokenRoots = next.broken
    if (switched) options.changed()
  }

  /** Build while stale, one build at a time; changes during a build build again after it. */
  function update() {
    building ??= (async () => {
      try {
        await mkdir(folder, { recursive: true })
        while (stale) {
          stale = false
          changedFiles = [...pending]
          pending = new Set()
          try {
            await buildOnce()
          } catch (error) {
            options.notice(`The web UI did not build: ${String(error)}`)
          }
        }
      } finally {
        building = undefined
      }
    })()
    return building
  }

  function touched(file: string) {
    pending.add(relative(ultimateRoot, file).startsWith('..') ? file : relative(ultimateRoot, file))
    stale = true
    clearTimeout(timer)
    if (options.pages() > 0) timer = setTimeout(() => void update(), 150)
  }
  const inside = (file: string, root: string) => file === root || file.startsWith(root + sep)
  const onChange = (file: string) => {
    if (file.includes(`${sep}node_modules${sep}`)) return
    if (inside(file, webRoot) || always.includes(file) || inputs.has(file)) return touched(file)
    if (roots.some((root) => inside(file, root)))
      void realpath(file).then(
        (real) =>
          (inputs.has(real) || brokenRoots.some((root) => inside(real, root))) && touched(file),
        () => touched(file), // Gone since the event: a source of the bundle may have been removed.
      )
  }
  const onStructure = (file: string) => {
    if (file.includes(`${sep}node_modules${sep}`)) return
    if (inside(file, webRoot) || roots.some((root) => inside(file, root))) touched(file)
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  const unwatch = options.watch((watcher) => {
    watcher.add([...roots, ...settings, webRoot])
    // A root missing at start (a project's first extension folder) is watched once it appears.
    const stopRoots = watchRoots([...roots, ...settings], (root) => {
      watcher.add(root)
      touched(root)
    })
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      stopRoots()
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })

  /** `path` in bundle `id`, when it is a file there. */
  async function bundled(id: string, path: string) {
    const base = join(folder, id)
    const full = resolve(base, '.' + path)
    if (!inside(full, base)) return undefined
    return stat(full).then(
      (info) => (info.isFile() ? full : undefined),
      () => undefined, // Not in this bundle.
    )
  }

  return {
    info: () => ({ id: manifest?.id ?? '', changed: changedFiles }),
    /** The facets the bundle's loader map holds, by web.tsx path, as the next build will see them. */
    facets: () => webFacets(ultimateRoot, projectRoot, userHome),
    /** Rebuild now when a page is open, else at the next page load; settles once applied. */
    async rebuild() {
      stale = true
      if (options.pages() > 0 || building) await update()
    },
    async handle(request: IncomingMessage, response: ServerResponse) {
      if (stale || !manifest) await update()
      if (!manifest) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('The web UI did not build; the notices name the error.')
        return
      }
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      const found =
        path !== '/' && path !== '/index.html'
          ? ((await bundled(manifest.id, path)) ?? (previous && (await bundled(previous, path))))
          : undefined
      if (!found) {
        if (extname(path) && path !== '/index.html') {
          response.writeHead(404)
          response.end()
          return
        }
        // The app, for every route: it names its bundle, so the page knows when a new one is current.
        const html = (await readFile(join(folder, manifest.id, 'index.html'), 'utf8')).replace(
          '<head>',
          `<head><meta name="ultimate-web" content="${manifest.id}">`,
        )
        response.writeHead(200, {
          'Content-Type': types['.html'],
          'Cache-Control': 'no-cache',
        })
        response.end(html)
        return
      }
      const gzip =
        /\bgzip\b/.test(request.headers['accept-encoding'] ?? '') &&
        (await stat(found + '.gz').then(
          () => true,
          () => false, // Small files are not compressed.
        ))
      response.writeHead(200, {
        'Content-Type': types[extname(found)] ?? 'application/octet-stream',
        // Asset names carry their content hash; the other public files can change in place.
        'Cache-Control': path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      })
      createReadStream(gzip ? found + '.gz' : found)
        .on('error', () => response.destroy())
        .pipe(response)
    },
    close() {
      clearTimeout(timer)
      unwatch()
      return building
    },
  }
}
