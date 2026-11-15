import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, relative, resolve, sep } from 'node:path'
import { inExtensionTests } from '../shared/extension-api.ts'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { exec } from '../lib/exec.ts'
import { debounce } from '../lib/timers.ts'
import { writeTextAtomically } from '../lib/json-file.ts'
import { discoverExtensions } from '../lib/discovery.ts'
import { discoveryRoots } from '../lib/project-paths.ts'
import { extensionSettingsFiles } from '../lib/extension-settings.ts'
import type { Watch } from './extensions.ts'
import { watchRoots } from './watch-roots.ts'
import type { WebBuildRequest, WebBuildResult } from './web-build.ts'

interface Manifest {
  id: string
  at: number
  inputs: string[]
  facets: string[]
  broken: string[]
  retired: Record<string, number>
}

const replacedBundleGracePeriodMs = 10 * 60_000
const missingSourceMeansChanged = Number.POSITIVE_INFINITY
const removedFileIsHandledByWatcher = 0

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
  before: () => Promise<unknown>
  pages: () => number
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
    (text) => {
      try {
        return JSON.parse(text) as Manifest
      } catch {
        return undefined
      }
    },
    () => undefined,
  )
  let inputs = new Set(manifest?.inputs)
  let brokenRoots = manifest?.broken ?? []
  const retired = new Map(Object.entries(manifest?.retired ?? {}))
  let stale = !manifest || !(await fresh(manifest))
  let building: Promise<void> | undefined
  let changedFiles: string[] = []
  let left: { file: string; error: string }[] = []
  let failed: string | undefined
  let pending = new Set<string>()
  const scheduleUpdate = debounce(150, () => void buildUntilFreshSerially())
  const closing = new AbortController()

  async function fresh(current: Manifest) {
    const facets = await webFacets(ultimateRoot, projectRoot, userHome)
    const retryPossiblyFixedFacets = current.broken?.length
    if (retryPossiblyFixedFacets || facets.join('\0') !== current.facets.join('\0')) return false
    const { at: buildStartedEpochMs } = current
    return !(await changedSince(current.inputs, buildStartedEpochMs))
  }

  async function savedSince(files: string[], at: number) {
    const times = await Promise.all(
      files.map((file) =>
        stat(file).then(
          (info) => info.mtimeMs,
          () => removedFileIsHandledByWatcher,
        ),
      ),
    )
    return times.some((time) => time > at)
  }

  async function changedSince(files: string[], at: number) {
    const times = await Promise.all(
      files.map((file) =>
        stat(file).then(
          (info) => info.mtimeMs,
          () => missingSourceMeansChanged,
        ),
      ),
    )
    return times.some((time) => time > at)
  }

  async function buildOnce() {
    const buildStartedEpochMs = Date.now()
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
        {
          cwd: ultimateRoot,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, NODE_ENV: 'production' },
          signal: closing.signal,
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
        failed = `The web UI did not build${file ? ` (${relative(ultimateRoot, file)})` : ''}: ${result.error.message}`
        options.notice(failed)
        return
      }
      broken[facet.name] = result.error.message
      brokenFolders.push(facet.target)
      left.push({ file: join(facet.path, 'web.tsx'), error: result.error.message })
      options.notice(`${join(facet.path, 'web.tsx')} did not build: ${result.error.message}`)
    }
    const allFileNamesAndContentsHash = createHash('sha256')
    for (const file of (await readdir(outDir, { recursive: true })).toSorted()) {
      const full = join(outDir, file)
      if ((await stat(full)).isFile())
        allFileNamesAndContentsHash.update(file + '\0').update(await readFile(full))
    }
    const id = allFileNamesAndContentsHash.digest('hex').slice(0, 12)
    const bundlePath = join(folder, id)
    const identicalBundleExists = await stat(bundlePath).then(
      () => true,
      () => false,
    )
    if (identicalBundleExists) await rm(outDir, { recursive: true, force: true })
    else await rename(outDir, bundlePath)
    const publicFiles = (
      await readdir(join(webRoot, 'public'), { recursive: true }).catch(() => [])
    ).map((file) => join(webRoot, 'public', file))
    const next: Manifest = {
      id,
      at: buildStartedEpochMs,
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
      retired: {},
    }
    const switched = manifest?.id !== id
    if (manifest && switched) retired.set(manifest.id, Date.now())
    retired.delete(id)
    for (const [old, since] of retired)
      if (Date.now() - since > replacedBundleGracePeriodMs) retired.delete(old)
    next.retired = Object.fromEntries(retired)
    await writeTextAtomically(join(folder, 'manifest.json'), JSON.stringify(next))
    manifest = next
    inputs = new Set(next.inputs)
    brokenRoots = next.broken
    const sourceSavedDuringBuild = await savedSince(result.inputs, buildStartedEpochMs)
    if (sourceSavedDuringBuild) stale = true
    for (const name of await readdir(folder))
      if (name !== id && !name.startsWith('.') && name !== 'manifest.json' && !retired.has(name))
        await rm(join(folder, name), { recursive: true, force: true })
  }

  function buildUntilFreshSerially() {
    building ??= (async () => {
      try {
        await mkdir(folder, { recursive: true })
        while (stale && !closing.signal.aborted) {
          await options.before()
          stale = false
          changedFiles = [...pending]
          pending = new Set()
          left = []
          failed = undefined
          options.changed()
          try {
            await buildOnce()
          } catch (error) {
            if (!closing.signal.aborted) {
              failed = `The web UI did not build: ${String(error)}`
              options.notice(failed)
            }
          }
        }
      } finally {
        building = undefined
        options.changed()
      }
    })()
    return building
  }

  function touched(file: string) {
    pending.add(relative(ultimateRoot, file).startsWith('..') ? file : relative(ultimateRoot, file))
    stale = true
    scheduleUpdate.cancel()
    if (options.pages() > 0) scheduleUpdate()
  }
  const inside = (file: string, root: string) => file === root || file.startsWith(root + sep)
  const tests = (file: string) =>
    roots.some((root) => inside(file, root) && inExtensionTests(relative(root, file)))
  const onChange = (file: string) => {
    if (file.includes(`${sep}node_modules${sep}`) || tests(file)) return
    if (inside(file, webRoot) || always.includes(file) || inputs.has(file)) return touched(file)
    if (roots.some((root) => inside(file, root)))
      void realpath(file).then(
        (real) =>
          (inputs.has(real) || brokenRoots.some((root) => inside(real, root))) && touched(file),
        () => touched(file),
      )
  }
  const onStructure = (file: string) => {
    if (file.includes(`${sep}node_modules${sep}`) || tests(file)) return
    if (inside(file, webRoot) || roots.some((root) => inside(file, root))) touched(file)
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  const unwatch = options.watch((watcher) => {
    watcher.add([...roots, ...settings, webRoot])
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

  async function bundled(id: string, path: string) {
    const base = join(folder, id)
    const full = resolve(base, '.' + path)
    if (!inside(full, base)) return undefined
    return stat(full).then(
      (info) => (info.isFile() ? full : undefined),
      () => undefined,
    )
  }

  return {
    info: () => ({
      id: manifest?.id ?? '',
      changed: changedFiles,
      ...(building ? { building: true } : {}),
      ...(left.length ? { left } : {}),
      ...(failed ? { error: failed } : {}),
    }),
    facets: () => webFacets(ultimateRoot, projectRoot, userHome),
    async rebuild() {
      stale = true
      if (options.pages() > 0 || building) await buildUntilFreshSerially()
    },
    async handle(request: IncomingMessage, response: ServerResponse) {
      if (stale || !manifest) await buildUntilFreshSerially()
      const bundleForEntireRequest = manifest
      if (!bundleForEntireRequest) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('The web UI did not build; the notices name the error.')
        return
      }
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      let found: string | undefined
      if (path !== '/' && path !== '/index.html')
        for (const id of [bundleForEntireRequest.id, ...retired.keys()]) {
          found = await bundled(id, path)
          if (found) break
        }
      if (!found) {
        if (extname(path) && path !== '/index.html') {
          response.writeHead(404)
          response.end()
          return
        }
        const html = (
          await readFile(join(folder, bundleForEntireRequest.id, 'index.html'), 'utf8')
        ).replace(
          '<head>',
          `<head><meta name="ultimate-web" content="${bundleForEntireRequest.id}">`,
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
          () => false,
        ))
      const contentAddressedAsset = path.startsWith('/assets/')
      response.writeHead(200, {
        'Content-Type': types[extname(found)] ?? 'application/octet-stream',
        'Cache-Control': contentAddressedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      })
      createReadStream(gzip ? found + '.gz' : found)
        .on('error', () => response.destroy())
        .pipe(response)
    },
    close() {
      scheduleUpdate.cancel()
      unwatch()
      closing.abort()
      return building
    },
  }
}
