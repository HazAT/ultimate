import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../../../lib/git.ts'
import { context } from '../../../../server/harness.ts'
import { Standing } from '../../../subagents/api.ts'
import { Workspaces } from '../../../workspaces/workspaces.ts'
import { fauxServer, post, sourceCopy, temp } from '../../../../test/helpers.ts'
import { RESTORE_PREFIX } from '../../merge.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const commit = (root: string, ...args: string[]) =>
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', ...args)

async function diverged(home: string, conflict = false) {
  const root = await sourceCopy(home)
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.email', 't@example.com')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'add', '-A')
  if (conflict) await writeFile(join(root, 'CONFLICT.md'), 'base\n')
  await commit(root, '-m', 'base')
  const upstream = join(home, 'upstream.git')
  await git(home, 'clone', '-q', '--bare', root, upstream)
  await git(root, 'remote', 'add', 'origin', upstream)
  if (conflict) {
    await writeFile(join(root, 'CONFLICT.md'), 'upstream\n')
    await git(root, 'add', '-A')
  }
  await commit(root, '--allow-empty', '-m', 'upstream')
  await git(root, 'push', '-q', 'origin', 'HEAD:main')
  await git(root, 'reset', '-q', '--hard', 'HEAD~1')
  if (conflict) {
    await writeFile(join(root, 'CONFLICT.md'), 'local\n')
    await git(root, 'add', '-A')
  }
  await commit(root, '--allow-empty', '-m', 'local')
  await git(root, 'fetch', '-q', 'origin')
  await git(root, 'remote', 'set-head', 'origin', 'main')
  return root
}

async function installMatches(root: string) {
  await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true })
  await copyFile(join(root, 'pnpm-lock.yaml'), join(root, 'node_modules/.pnpm/lock.yaml'))
}

async function fakePnpm(home: string, status: number) {
  const dir = join(home, 'bin')
  const log = join(home, 'pnpm-calls')
  await mkdir(dir, { recursive: true })
  const script = join(dir, 'pnpm')
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `echo "$1" >> ${JSON.stringify(log)}`,
      'if [ "$1" = check ]; then',
      `  echo "vp check: ${status === 0 ? 'all green' : 'a type error in src.ts'}" ${status === 0 ? '' : '>&2'}`,
      `  exit ${status}`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(script, 0o755)
  return {
    enter: () => {
      const path = process.env.PATH
      process.env.PATH = `${dir}:${path}`
      return () => {
        process.env.PATH = path!
      }
    },
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
  }
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
    diverged: true,
    conflicts: false,
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

  await writeFile(join(root, 'README.md'), 'local edit\n')
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

it.concurrent('refuses an update whose merge would conflict, leaving the clone untouched', async () => {
  const home = await temp()
  const root = await diverged(home, true)
  const server = await serve(home, root, root)
  const state = await post(server, '/api/extensions/update/actions/state', {})
  expect(state.data.result).toMatchObject({ diverged: true, conflicts: true, merge: true })
  const mine = await git(root, 'rev-parse', 'HEAD')
  const updated = await post(server, '/api/extensions/update/actions/update', {})
  expect(updated.status).toBe(200)
  expect(updated.data.result).toMatchObject({ ok: false })
  expect(updated.data.result.refused).toContain('would conflict')
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(mine)
  expect(await git(root, 'for-each-ref', `${RESTORE_PREFIX}*`)).toBe('')
})

it('merges a diverged clone through Update now, checks it and offers the undo', async () => {
  const home = await temp()
  const root = await diverged(home)
  await installMatches(root)
  const fake = await fakePnpm(home, 0)
  const server = await serve(home, root, root)
  const mine = await git(root, 'rev-parse', 'HEAD')
  const restore = fake.enter()
  const updated = await post(server, '/api/extensions/update/actions/update', {})
  restore()
  expect(updated.status).toBe(200)
  expect(updated.data.result).toMatchObject({ ok: true, merged: true, check: 'passed' })
  expect((await git(root, 'cat-file', '-p', 'HEAD')).match(/^parent /gm)).toHaveLength(2)
  expect(await git(root, 'merge-base', '--is-ancestor', mine, 'HEAD')).toBe('')
  const ref = updated.data.result.restore as string
  expect(ref.startsWith(RESTORE_PREFIX)).toBe(true)
  expect(await git(root, 'rev-parse', ref)).toBe(mine)
  expect(await fake.calls()).toEqual(['check'])
  const state = await post(server, '/api/extensions/update/actions/state', {})
  expect(state.data.result.updated).toMatchObject({ ok: true, merged: true, check: 'passed' })
})

it('keeps a merged update whose check fails, offering @ultimate to fix it once', async () => {
  const home = await temp()
  const root = await diverged(home)
  await installMatches(root)
  const fake = await fakePnpm(home, 1)
  const server = await serve(home, root, root)
  const restore = fake.enter()
  const updated = await post(server, '/api/extensions/update/actions/update', {})
  restore()
  expect(updated.data.result).toMatchObject({
    ok: true,
    merged: true,
    check: 'failed',
    fixable: true,
  })
  expect(updated.data.result.checkError).toContain('type error')
  expect((await git(root, 'cat-file', '-p', 'HEAD')).match(/^parent /gm)).toHaveLength(2)
  expect((updated.data.result.restore as string).startsWith(RESTORE_PREFIX)).toBe(true)
  for (let click = 0; click < 2; click++) {
    const fixed = await post(server, '/api/extensions/update/actions/merge', {})
    expect(fixed.status).toBe(200)
    await server.harness.waitForIdle(context)
  }
  const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  const conversation = (await server.harness.conversation(standing!.ultimate, context))!
  const messages = JSON.stringify((await conversation.context(context)).messages)
  expect(messages.match(/the update merged origin into main in /g)).toHaveLength(1)
  expect(messages).toContain('pnpm check fails')
  expect(messages).toContain('workspace submit')
})
