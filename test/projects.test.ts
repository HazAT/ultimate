import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxServer, post, temp, until } from './helpers.ts'
import { projectHome, projects, conversationIndex } from '../server/project.ts'
import { context } from '../server/harness.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  // In parallel, like the other server tests: two closes in a row overran the 5 s hook under load.
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

it('keeps stores local while exposing projects, conversations and live URLs through the host', async () => {
  const userHome = await temp('ultimate-projects-')
  const aRoot = join(userHome, 'a')
  const bRoot = join(userHome, 'b')
  for (const root of [aRoot, bRoot]) {
    await mkdir(join(root, '.ultimate'), { recursive: true })
    // This test observes input-derived titles, not the background summary model.
    await writeFile(
      join(root, '.ultimate/settings.json'),
      JSON.stringify({ summaryModel: 'unavailable/test' }),
    )
  }
  const launch = async (projectRoot: string) => {
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      userHome,
      home: projectHome(projectRoot, userHome),
    })
    servers.push(server)
    return server
  }
  const a = await launch(aRoot)
  expect(JSON.parse(await readFile(join(a.host.home, 'project.json'), 'utf8'))).toEqual({
    root: aRoot,
    name: 'a',
    openedAt: expect.any(Number),
  })
  await post(a, '/api/conversations/1/submit', { text: 'A titled conversation' })
  await a.harness.waitForIdle(context)
  const indexPath = join(a.host.home, 'conversations.json')
  await until(async () => {
    try {
      return JSON.parse(await readFile(indexPath, 'utf8'))[0]?.answerAt !== undefined
    } catch {
      return false
    }
  })
  const conversations = JSON.parse(await readFile(indexPath, 'utf8'))
  expect(conversations).toEqual([
    {
      id: 1,
      title: 'A titled conversation',
      cwd: aRoot,
      inputAt: expect.any(Number),
      answerAt: expect.any(Number),
    },
  ])
  await writeFile(
    join(a.host.home, 'ultimate.lock'),
    JSON.stringify({ pid: process.pid, port: a.port, project: aRoot }),
  )
  const b = await launch(bRoot)
  // Capture the actual ExtensionHost via an extension action, not a parallel test API.
  await mkdir(join(bRoot, '.ultimate/extensions/inventory'), { recursive: true })
  await writeFile(
    join(bRoot, '.ultimate/extensions/inventory/server.ts'),
    `export const actions = { list: async (_args, { host }) => host.projects() }; export default { name: 'inventory' }`,
  )
  await until(() =>
    b.extensions
      .info()
      .some((item) => item.name === 'inventory' && item.server?.loadedAt !== undefined),
  )
  const result = await post(b, '/api/extensions/inventory/actions/list', { args: {} })
  expect(result.status).toBe(200)
  expect(result.data.result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        root: aRoot,
        current: false,
        conversations,
        running: { pid: process.pid, url: a.url },
      }),
      expect.objectContaining({ root: bRoot, current: true }),
    ]),
  )
  expect(b.api.conversations().some((item) => item.title === 'A titled conversation')).toBe(false)
})

it('lists unknown homes and ignores dead locks; skips unchanged index writes and excludes children', async () => {
  const userHome = await temp('ultimate-project-index-')
  const home = join(userHome, '.ultimate/projects/old-home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
  expect(await projects(userHome, home)).toEqual([
    { home, name: 'old-home', current: true, conversations: [] },
  ])
  const corrupt = join(userHome, '.ultimate/projects/corrupt')
  await mkdir(corrupt)
  for (const file of ['project.json', 'conversations.json', 'ultimate.lock'])
    await writeFile(join(corrupt, file), '{invalid JSON')
  expect(await projects(userHome, home)).toEqual([
    { home: corrupt, name: 'corrupt', current: false, conversations: [] },
    { home, name: 'old-home', current: true, conversations: [] },
  ])
  const index = conversationIndex(home)
  const summaries = [
    { id: 1, cwd: '/a', busy: false },
    { id: 2, cwd: '/a', busy: false, parentConversationId: 1 },
    { id: 3, cwd: '/a', busy: false, ownerTaskId: 1 },
  ]
  index.update(summaries)
  await index.flush()
  const path = join(home, 'conversations.json')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([{ id: 1, cwd: '/a' }])
  const before = (await stat(path)).mtimeMs
  index.update(summaries.map((item) => ({ ...item, busy: true })))
  await index.flush()
  expect((await stat(path)).mtimeMs).toBe(before)
})
