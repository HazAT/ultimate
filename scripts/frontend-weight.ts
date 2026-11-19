import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { git } from '../lib/git.ts'

const run = promisify(execFile)
const root = process.cwd()
const tracked = (await git(root, 'ls-files')).split('\n').filter(Boolean)
const frontend = tracked.filter(
  (file) =>
    !/(^|\/)test\//.test(file) &&
    (file.startsWith('web/src/') || /^extensions\/[^/]+\/.*\.tsx$/.test(file)) &&
    /\.(tsx?|css)$/.test(file),
)
const lines = async (file: string) =>
  (await readFile(join(root, file), 'utf8')).split('\n').filter((line) => line.trim()).length
const counted = await Promise.all(
  frontend.map(async (file) => ({ file, lines: await lines(file) })),
)
const sum = (files: { lines: number }[]) => files.reduce((total, file) => total + file.lines, 0)
const solid = counted.filter(({ file }) => file.endsWith('.solid.tsx'))

const home = await mkdtemp(join(tmpdir(), 'frontend-weight-'))
try {
  await run(
    process.execPath,
    [
      'server/web-build.ts',
      JSON.stringify({
        ultimateRoot: root,
        projectRoot: root,
        userHome: home,
        outDir: join(home, 'out'),
        cacheDir: join(home, 'cache'),
        broken: {},
      }),
    ],
    { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 64 * 1024 * 1024 },
  )
  const assets = join(home, 'out', 'assets')
  const bundle = { js: 0, jsGzip: 0, css: 0, cssGzip: 0 }
  for (const name of await readdir(assets)) {
    const kind = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : undefined
    if (!kind) continue
    const content = await readFile(join(assets, name))
    bundle[kind] += (await stat(join(assets, name))).size
    bundle[`${kind}Gzip`] += gzipSync(content).length
  }
  const page = await readFile(join(home, 'out', 'index.html'), 'utf8')
  const entry = [...page.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  )
  let entryGzip = 0
  for (const file of new Set(entry))
    entryGzip += gzipSync(await readFile(join(home, 'out', file))).length
  const kb = (bytes: number) => Math.round(bytes / 1024)
  console.log(
    JSON.stringify(
      {
        rev: await git(root, 'rev-parse', '--short', 'HEAD'),
        dirty: (await git(root, 'status', '--porcelain')).length > 0,
        lines: {
          frontend: sum(counted),
          webSrc: sum(counted.filter(({ file }) => file.startsWith('web/src/'))),
          extensionsTsx: sum(counted.filter(({ file }) => file.startsWith('extensions/'))),
          solid: sum(solid),
          files: counted.length,
          solidFiles: solid.length,
        },
        bundleKb: {
          js: kb(bundle.js),
          jsGzip: kb(bundle.jsGzip),
          css: kb(bundle.css),
          cssGzip: kb(bundle.cssGzip),
          entryAssetsGzip: kb(entryGzip),
        },
        heaviest: counted
          .toSorted((a, b) => b.lines - a.lines)
          .slice(0, 5)
          .map(({ file, lines: count }) => `${count} ${file}`),
      },
      null,
      2,
    ),
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
