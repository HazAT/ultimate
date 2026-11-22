import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { reactFacetRemoved } from '../lib/discovery.ts'

const clone = resolve(import.meta.dirname, '..')
const own = resolve('.ultimate/extensions')
const folders =
  process.argv.length > 2
    ? process.argv.slice(2).map((path) => resolve(path))
    : existsSync(own)
      ? readdirSync(own, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => join(own, entry.name))
      : []
if (!folders.length) {
  console.log(
    'No extensions to check: pass extension folders or run it in a project with .ultimate/extensions/.',
  )
  process.exit(0)
}
const reactFacets = folders.filter((folder) => existsSync(join(folder, 'web.tsx')))
if (reactFacets.length) {
  for (const folder of reactFacets)
    console.error(`${join(folder, 'web.tsx')}: ${reactFacetRemoved}`)
  process.exit(1)
}
for (const folder of folders)
  if (!['web.solid.tsx', 'server.ts'].some((file) => existsSync(join(folder, file)))) {
    console.error(`${folder} is not an extension folder (no web.solid.tsx or server.ts).`)
    process.exit(2)
  }

const letTscExitBeforeRemovingTemp = () => {}
process.on('SIGINT', letTscExitBeforeRemovingTemp)
process.on('SIGTERM', letTscExitBeforeRemovingTemp)
const temp = mkdtempSync(join(tmpdir(), 'ultimate-check-extension-'))
let status = 1
try {
  symlinkSync(join(clone, 'node_modules'), join(temp, 'node_modules'))
  mkdirSync(join(temp, 'ext'))
  const links = folders.map((folder, index) => {
    const link = `ext/${index}-${basename(folder)}`
    symlinkSync(folder, join(temp, link))
    return { link, folder }
  })
  const web = JSON.parse(readFileSync(join(clone, 'tsconfig.web.json'), 'utf8'))
  const cloneWebAndBundlerOptions = web.compilerOptions
  writeFileSync(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...cloneWebAndBundlerOptions,
        composite: false,
        emitDeclarationOnly: false,
        outDir: undefined,
        noEmit: true,
        types: [...cloneWebAndBundlerOptions.types, 'node'],
        paths: Object.fromEntries(
          Object.entries(cloneWebAndBundlerOptions.paths as Record<string, string[]>).map(
            ([alias, targets]) => [alias, targets.map((target) => join(clone, target))],
          ),
        ),
      },
      include: ['ext/*/web.solid.tsx', 'ext/*/server.ts'],
    }),
  )
  const tsc = spawnSync(join(clone, 'node_modules/.bin/tsc'), ['-p', '.', '--pretty', 'false'], {
    cwd: temp,
    encoding: 'utf8',
  })
  let output = (tsc.stdout + tsc.stderr).replaceAll(temp + '/', '')
  for (const { link, folder } of links) output = output.replaceAll(link, folder)
  process.stdout.write(output)
  status = tsc.status ?? 1
  if (status === 0) console.log(`${folders.length} extension(s) type-check.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
process.exit(status)
