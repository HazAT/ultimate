import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, temp } from './helpers.ts'
import { projects, registerLocalHome, writeProject } from '../server/project.ts'
import { projectHome } from '../lib/project-paths.ts'
import { resolveProject } from '../lib/remote.ts'

it('lists a project opened with an explicit home to the other projects of the same user home', async () => {
  const userHome = await temp('ultimate-opened-local-home-')
  const projectRoot = join(userHome, 'app')
  await mkdir(projectRoot)
  const home = join(userHome, 'explicit-state')
  const server = await fauxServer({ ultimateRoot: resolve('.'), projectRoot, userHome, home })
  try {
    const other = projectHome(join(userHome, 'other'), userHome)
    expect((await projects(userHome, other)).filter((item) => item.home === home)).toEqual([
      expect.objectContaining({ root: projectRoot, name: 'app', current: false }),
    ])
  } finally {
    await server.close()
  }
})

it('indexes only explicit homes and keeps stopped projects discoverable without duplicates', async () => {
  const userHome = await temp('ultimate-local-homes-')
  const root = join(userHome, 'app')
  const standard = projectHome(root, userHome)
  await mkdir(standard, { recursive: true })
  await writeProject(standard, root)
  await registerLocalHome(userHome, standard, root)
  const directory = join(userHome, '.ultimate/local-homes')
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })

  const tool = join(userHome, 'tool')
  const home = join(userHome, 'explicit-state')
  await mkdir(home)
  await writeProject(home, tool)
  await registerLocalHome(userHome, home, tool)
  const [file] = await readdir(directory)
  expect(file).toBe(createHash('sha256').update(home).digest('hex') + '.json')
  expect(JSON.parse(await readFile(join(directory, file), 'utf8'))).toEqual({ home, root: tool })
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
  const listed = await projects(userHome, home)
  expect(listed.filter((item) => item.home === home)).toEqual([
    expect.objectContaining({ root: tool, name: 'tool', current: true }),
  ])
  const [stopped] = (await projects(userHome, standard)).filter((item) => item.home === home)
  expect(stopped.running).toBeUndefined()
  expect(() => resolveProject('tool', [stopped], undefined)).toThrow(
    'tool is not running on this machine; start it to query it',
  )
})

it('lists a project once when a stopped explicit home shares its root with another home', async () => {
  const userHome = await temp('ultimate-local-home-duplicate-')
  const root = join(userHome, 'app')
  const standard = projectHome(root, userHome)
  await mkdir(standard, { recursive: true })
  await writeProject(standard, root)
  await writeFile(
    join(standard, 'ultimate.lock'),
    JSON.stringify({ pid: process.pid, port: 4747, project: root }),
  )
  const scratch = join(userHome, 'scratch-state')
  await mkdir(scratch)
  await writeProject(scratch, root)
  await registerLocalHome(userHome, scratch, root)
  const other = projectHome(join(userHome, 'other'), userHome)
  const listed = (await projects(userHome, other)).filter((item) => item.root === root)
  expect(listed).toEqual([expect.objectContaining({ home: standard })])
  expect(resolveProject('app', listed, undefined)).toMatchObject({ url: 'http://127.0.0.1:4747' })
  expect(
    (await projects(userHome, scratch)).filter((item) => item.root === root).map((p) => p.home),
  ).toEqual([standard, scratch].toSorted())
})

it('ignores invalid registrations and metadata that is missing or no longer matches', async () => {
  const userHome = await temp('ultimate-invalid-local-homes-')
  const current = join(userHome, 'current')
  const directory = join(userHome, '.ultimate/local-homes')
  await mkdir(directory, { recursive: true })
  const register = async (home: string, root: unknown, file?: string) => {
    await writeFile(
      join(directory, file ?? createHash('sha256').update(home).digest('hex') + '.json'),
      JSON.stringify({ home, root }),
    )
  }
  const root = join(userHome, 'app')
  for (const name of ['wrong-hash', 'wrong-root', 'wrong-name', 'relative-root', 'missing']) {
    const home = join(userHome, name)
    await mkdir(home)
    await writeProject(home, root)
    await register(
      home,
      name === 'wrong-root' ? join(userHome, 'other') : name === 'relative-root' ? 'app' : root,
      name === 'wrong-hash' ? 'not-the-home-hash.json' : undefined,
    )
    if (name === 'missing') await rm(join(home, 'project.json'))
    if (name === 'wrong-name')
      await writeFile(join(home, 'project.json'), JSON.stringify({ root, name: 'other' }))
  }
  await register('relative-state', root)
  await register(join(userHome, 'x'.repeat(4096)), root)
  await register(join(userHome, 'nul\0home'), root)
  await writeFile(join(directory, 'broken.json'), '{broken')
  await writeFile(join(directory, 'null.json'), 'null')
  expect(await projects(userHome, current)).toEqual([
    { home: current, name: 'current', current: true, conversations: [] },
  ])
})
