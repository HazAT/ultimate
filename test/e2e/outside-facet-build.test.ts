import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

const homes: string[] = []
afterAll(async () => {
  for (const home of homes.splice(0)) await removeTemp(home)
})

it('builds the classes of a project extension folder created while the host runs', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const css = async () => {
      const page = await (await fetch(server.url)).text()
      const sheet = /href="(\/assets\/[^"]+\.css)"/.exec(page)![1]
      return (await fetch(server.url + sheet)).text()
    }
    expect(await css()).not.toContain('37deg')
    const dir = join(projectRoot, '.ultimate/extensions/scratch')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'web.tsx'),
      'export const Chevron = () => <span className="rotate-[37deg]" />\n',
    )
    // No page is open: a page load after the change builds the new bundle.
    await until(async () => (await css()).includes('37deg'))
    const bundles = await readdir(join(home, 'state/web'))
    const manifest = JSON.parse(await readFile(join(home, 'state/web/manifest.json'), 'utf8'))
    expect(bundles).toContain(manifest.id)
  } finally {
    await server.close()
  }
})

it('compiles an outside React facet to the automatic JSX runtime, whatever its own tsconfig says', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  const dir = join(projectRoot, '.ultimate/extensions/counter')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "jsx": "react" } }')
  await writeFile(
    join(dir, 'web.tsx'),
    [
      "import { useState } from 'react'",
      'export function Counter() {',
      '  const [count, setCount] = useState(0)',
      '  return <button onClick={() => setCount(count + 1)}>counted-{count}</button>',
      '}',
      "export default { slots: { 'statusline.left': Counter } }",
    ].join('\n'),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    await (await fetch(server.url)).text()
    const manifest = JSON.parse(await readFile(join(home, 'state/web/manifest.json'), 'utf8'))
    const assets = join(home, 'state/web', manifest.id, 'assets')
    const chunks = await Promise.all(
      (await readdir(assets))
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFile(join(assets, name), 'utf8')),
    )
    const facet = chunks.find((chunk) => chunk.includes('counted-'))!
    expect(facet).not.toContain('createElement')
    expect(facet).toMatch(/\.jsxs?\)?\(/)
  } finally {
    await server.close()
  }
})
