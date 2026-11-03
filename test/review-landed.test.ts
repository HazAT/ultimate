import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { git } from '../lib/git.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from './helpers.ts'

it('shows a landed branch as its landing range once its ref is gone, and moves on without one', async () => {
  const home = await temp('ultimate-review-landed-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  await git(project, 'init', '-q', '-b', 'main')
  await git(project, 'config', 'user.email', 'test@example.com')
  await git(project, 'config', 'user.name', 'Test')
  await writeFile(join(project, 'a.txt'), 'one\n')
  await git(project, 'add', '-A')
  await git(project, 'commit', '-q', '-m', 'first')
  const base = await git(project, 'rev-parse', 'HEAD')
  await git(project, 'checkout', '-q', '-b', 'ultimate/feature')
  await writeFile(join(project, 'feature.txt'), 'new\n')
  await git(project, 'add', '-A')
  await git(project, 'commit', '-q', '-m', 'add feature')
  const tip = await git(project, 'rev-parse', 'HEAD')
  // It landed: main fast-forwarded to its tip, and the worktree's removal deleted its branch.
  await git(project, 'checkout', '-q', 'main')
  await git(project, 'merge', '-q', '--ff-only', tip)
  await git(project, 'branch', '-q', '-D', 'ultimate/feature')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    const workspace = { path: join(home, 'gone'), base, source: project, target: 'main' }
    const lander = { target: 'main', lander: 3, steps: [], at: 1, divergence: 'None' }
    await server.harness.commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      index.items['7'] = { ...workspace, branch: 'ultimate/feature', state: 'removed', landed: tip }
      index.items['8'] = { ...workspace, branch: 'ultimate/dropped', state: 'removed' }
      index.results.s1 = { ...lander, outcome: 'landed', sha: tip, base, tip, conversationId: 7 }
    }, context)
    const diff = async (spec: string) =>
      (await post(server, '/api/extensions/review/actions/diff', { args: { spec } })).data.result

    // The spec stays, so its drafts do; the diff is what the branch brought.
    const landed = await diff('branch:ultimate/feature')
    expect(landed).toMatchObject({
      spec: 'branch:ultimate/feature',
      kind: 'range',
      base,
      head: tip,
    })
    expect(landed.files.map((file: { path: string }) => file.path)).toEqual(['feature.txt'])
    // Without a landing, the panel moves on to the working tree instead of asking for the deleted ref.
    expect(await diff('branch:ultimate/dropped')).toMatchObject({
      spec: 'uncommitted',
      kind: 'uncommitted',
    })
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
