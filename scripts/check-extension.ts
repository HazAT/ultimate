// Type-checks extensions that live outside the clone (a project's `.ultimate/extensions/<name>/`, a linked user
// extension) against the clone's types, packages and TypeScript, as the host resolves them at runtime
// (`server/vite-extensions.ts`). Writes nothing into the clone or the project: the check runs in a temporary folder that
// links the clone's `node_modules` and each extension. Types only; the clone's lint rules are about the clone.
// Usage, from the project: node <clone>/scripts/check-extension.ts [extension folder…]
// (default: every folder in ./.ultimate/extensions).
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
for (const folder of folders)
  if (!existsSync(join(folder, 'web.tsx')) && !existsSync(join(folder, 'server.ts'))) {
    console.error(`${folder} is not an extension folder (no web.tsx or server.ts).`)
    process.exit(2)
  }

// Without a handler Ctrl-C ends Node at once and `finally` never removes the folder; tsc gets the signal itself.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
const temp = mkdtempSync(join(tmpdir(), 'ultimate-check-extension-'))
let status = 1
try {
  // Bare imports resolve upward from the importing file, and tsc keeps a link's path (no `preserveSymlinks`, which
  // breaks pnpm's links inside the clone), so linked extensions find the clone's packages here.
  symlinkSync(join(clone, 'node_modules'), join(temp, 'node_modules'))
  mkdirSync(join(temp, 'ext'))
  const links = folders.map((folder, index) => {
    const link = `ext/${index}-${basename(folder)}`
    symlinkSync(folder, join(temp, link))
    return { link, folder }
  })
  // The web project's options, so the check follows the clone's config; Bundler resolution also suits server facets,
  // which Vite loads (NodeNext would want a `"type": "module"` package.json above them).
  const web = JSON.parse(readFileSync(join(clone, 'tsconfig.web.json'), 'utf8'))
  const options = web.compilerOptions
  writeFileSync(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        composite: false,
        emitDeclarationOnly: false,
        outDir: undefined,
        noEmit: true,
        types: [...options.types, 'node'],
        paths: { '@/*': [join(clone, 'web/src/*')] },
      },
      include: ['ext/*/web.tsx', 'ext/*/server.ts'],
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
