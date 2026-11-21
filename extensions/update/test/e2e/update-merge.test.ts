import { copyFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../../../lib/git.ts'
import { context } from '../../../../server/harness.ts'
import { Standing } from '../../../subagents/api.ts'
import { Workspaces } from '../../../workspaces/workspaces.ts'
import { eventHost, fauxServer, post, sourceCopy, temp } from '../../../../test/helpers.ts'
import { Applied } from '../../refs.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const commit = (root: string, ...args: string[]) =>
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', ...args)

/** A copy of Ultimate whose `main` has one commit of its own and lacks one new commit on origin. */
async function diverged(home: string) {
  const root = await sourceCopy(home)
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'add', '-A')
  await commit(root, '-m', 'base')
  const upstream = join(home, 'upstream.git')
  await git(home, 'clone', '-q', '--bare', root, upstream)
  await git(root, 'remote', 'add', 'origin', upstream)
  await commit(root, '--allow-empty', '-m', 'upstream')
  await git(root, 'push', '-q', 'origin', 'HEAD:main')
  await git(root, 'reset', '-q', '--hard', 'HEAD~1')
  await commit(root, '--allow-empty', '-m', 'local')
  await git(root, 'fetch', '-q', 'origin')
  await git(root, 'remote', 'set-head', 'origin', 'main')
  return root
}

async function serve(home: string, ultimateRoot: string, projectRoot: string) {
  const server = await fauxServer({
    ultimateRoot,
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  })
  servers.push(server)
  return server
}

it.concurrent('asks @ultimate once to merge origin into a diverged clone that is the project', async () => {
  const home = await temp()
  const root = await diverged(home)
  const server = await serve(home, root, root)
  const state = await post(server, '/api/extensions/update/actions/state', {})
  expect(state.data.result).toMatchObject({
    branch: 'main',
    ahead: 1,
    behind: 1,
    refused: 'main has diverged from origin/main',
    merge: true,
  })
  for (let click = 0; click < 2; click++) {
    const merged = await post(server, '/api/extensions/update/actions/merge', {})
    expect(merged.status).toBe(200)
    await server.harness.waitForIdle(context)
  }
  const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  const conversation = (await server.harness.conversation(standing!.ultimate, context))!
  const messages = JSON.stringify((await conversation.context(context)).messages)
  expect(messages.match(/Update with @ultimate: main in /g)).toHaveLength(1)
  expect(messages).toContain('a normal git merge origin/main, never a rebase')
  expect(messages).toContain('workspace submit')

  // Any other refusal keeps its own text and offers no merge.
  await writeFile(join(root, 'README.md'), 'local edit\n')
  // The merge action reads the clone again rather than the last check.
  const refused = await post(server, '/api/extensions/update/actions/merge', {})
  expect(refused.status).not.toBe(200)
  expect(JSON.stringify(refused.data)).toContain('The checkout has uncommitted changes')
})

it.concurrent('offers no merge while the lander is landing into the clone', async () => {
  const home = await temp()
  const root = await diverged(home)
  const server = await serve(home, root, root)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.push({
      source: await realpath(root),
      state: 'landing',
    } as never)
  }, context)
  const state = await post(server, '/api/extensions/update/actions/state', {})
  expect(state.data.result).toMatchObject({ refused: 'main has diverged from origin/main' })
  expect(state.data.result.merge).toBeUndefined()
  expect((await post(server, '/api/extensions/update/actions/merge', {})).status).not.toBe(200)
})

it.concurrent('offers no merge where the clone is not the project', async () => {
  const home = await temp()
  const root = await diverged(home)
  const project = join(home, 'project')
  await mkdir(project)
  const server = await serve(home, root, project)
  const state = await post(server, '/api/extensions/update/actions/state', {})
  expect(state.data.result).toMatchObject({ refused: 'main has diverged from origin/main' })
  expect(state.data.result.merge).toBeUndefined()
  const merge = await post(server, '/api/extensions/update/actions/merge', {})
  expect(merge.status).not.toBe(200)
})

// A restart-after-update automation fired on every update: its where-filter cannot read the nested layers.
it.concurrent('says in update.applied whether the update changed the core', async () => {
  const home = await temp()
  const root = await sourceCopy(home)
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'add', '-A')
  await commit(root, '-m', 'base')
  const upstream = join(home, 'upstream.git')
  await git(home, 'clone', '-q', '--bare', root, upstream)
  await git(root, 'remote', 'add', 'origin', upstream)
  await writeFile(join(root, 'server/added.ts'), 'export {}\n')
  await git(root, 'add', '-A')
  await commit(root, '-m', 'core')
  await git(root, 'push', '-q', 'origin', 'HEAD:main')
  await git(root, 'reset', '-q', '--hard', 'HEAD~1')
  await git(root, 'fetch', '-q', 'origin')
  await git(root, 'branch', '-q', '--set-upstream-to', 'origin/main')
  await git(root, 'remote', 'set-head', 'origin', 'main')
  await rm(join(root, 'node_modules/.pnpm'))
  await mkdir(join(root, 'node_modules/.pnpm'))
  await copyFile(join(root, 'pnpm-lock.yaml'), join(root, 'node_modules/.pnpm/lock.yaml'))
  const server = await serve(home, root, root)
  const updated = await post(server, '/api/extensions/update/actions/update', {})
  expect(updated.data.result).toMatchObject({ ok: true, commits: 1 })
  const [applied] = await eventHost(() => server.harness, 'test').eventLog.recent({
    events: [Applied],
  })
  expect(applied.data).toMatchObject({ needsRestart: true, layers: { core: true } })
})
