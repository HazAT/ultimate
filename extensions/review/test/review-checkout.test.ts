import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { git } from '../../../lib/git.ts'
import { Workspaces } from '../../workspaces/workspaces.ts'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../../../test/helpers.ts'

/** A repository with one commit; returns its sha. */
async function repository(path: string) {
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '-b', 'main')
  await git(path, 'config', 'user.email', 'test@example.com')
  await git(path, 'config', 'user.name', 'Test')
  await writeFile(join(path, 'a.txt'), 'one\n')
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', 'first')
  return git(path, 'rev-parse', 'HEAD')
}

it('reviews the subfolder repository a conversation works in, the project root being no repository', async () => {
  const home = await temp('ultimate-review-subfolder-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  // The project root is no repository of its own: the app beside it is, as one repository per product folder.
  const app = join(project, 'app')
  const first = await repository(app)
  await writeFile(join(app, 'feature.txt'), 'new\n')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    const conversation = (await post(server, '/api/conversations', { title: 'App work', cwd: app }))
      .data.id as number
    const ranges = async (args: unknown) =>
      (await post(server, '/api/extensions/review/actions/ranges', { args })).data.result
    const once = await ranges({ conversation })
    expect(once).toContainEqual({
      spec: 'uncommitted',
      group: 'Working tree',
      label: 'Uncommitted changes',
    })
    expect(once).toContainEqual(
      expect.objectContaining({ spec: first, group: 'Commits', label: 'first' }),
    )
    // No conversation: the project's own checkout, which has nothing to list but the working tree.
    expect(await ranges(null)).toEqual([
      { spec: 'uncommitted', group: 'Working tree', label: 'Uncommitted changes' },
    ])
    const diff = async (spec: string, id?: number) =>
      (
        await post(server, '/api/extensions/review/actions/diff', {
          args: id === undefined ? { spec } : { spec, conversation: id },
        })
      ).data
    const shown = await diff('uncommitted', conversation)
    expect(shown.result).toMatchObject({ spec: 'uncommitted', kind: 'uncommitted', base: first })
    expect(shown.result.files.map((file: { path: string }) => file.path)).toEqual(['feature.txt'])
    // Without the conversation the same spec is asked of the project root, which is no repository: it says so.
    expect((await diff('uncommitted')).error).toMatch(/No Git repository in/)
    // A commit's trailer is read in that checkout too: the review goes to the conversation the commit names.
    await writeFile(join(app, 'b.txt'), 'two\n')
    await git(app, 'add', '-A')
    await git(app, 'commit', '-q', '-m', 'second', '-m', `Ultimate-Conversation: ${conversation}`)
    const second = await git(app, 'rev-parse', 'HEAD')
    const recipient = (
      await post(server, '/api/extensions/review/actions/recipient', {
        args: { spec: second, conversation },
      })
    ).data.result
    expect(recipient).toEqual({ conversation })
  } finally {
    await server.close()
    await removeTemp(home)
  }
})

it('reads the repository a released worktree branched from, not the project root', async () => {
  const home = await temp('ultimate-review-released-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  const source = join(project, 'backend')
  const first = await repository(source)
  await writeFile(join(source, 'server.txt'), 'changed\n')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    // A branch concluded and its worktree released: what is left of it is the repository it branched from.
    await server.harness.commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      index.items['7'] = {
        path: join(home, 'gone'),
        base: first,
        source,
        target: 'main',
        branch: 'ultimate/feature',
        state: 'removed',
      }
    }, context)
    const diff = (
      await post(server, '/api/extensions/review/actions/diff', {
        args: { spec: 'uncommitted', conversation: 7 },
      })
    ).data.result
    expect(diff).toMatchObject({ spec: 'uncommitted', kind: 'uncommitted', base: first })
    expect(diff.files.map((file: { path: string }) => file.path)).toEqual(['server.txt'])
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
