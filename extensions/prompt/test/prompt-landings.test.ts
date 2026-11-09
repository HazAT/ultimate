import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git } from '../../../lib/git.ts'
import { buildNote, landings } from '../server.ts'
import { temp } from '../../../test/helpers.ts'

it('names the branches that landed between two commits, a worker under its branch', async () => {
  const cwd = await temp()
  // commit-tree runs no hooks, so Ultimate's own trailer hook (set when this runs from its bash) stays out.
  const commit = async (subject: string, trailer?: number) => {
    await writeFile(join(cwd, 'file'), subject)
    await git(cwd, 'add', '.')
    const tree = await git(cwd, 'write-tree')
    const parent = await git(cwd, 'rev-parse', '--verify', '-q', 'HEAD').catch(
      // The first commit has no parent.
      () => '',
    )
    const sha = await git(
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      trailer ? `${subject}\n\nUltimate-Conversation: ${trailer}` : subject,
    )
    await git(cwd, 'update-ref', 'HEAD', sha)
    return sha
  }
  await git(cwd, 'init', '-q')
  const from = await commit('base')
  await commit('questions: answer card', 50)
  await commit('Merge 1234567 from #40 into main')
  await commit('hand edit')
  const to = await commit('skills: chip', 60)
  const conversations = [
    { id: 40, title: 'Answer card redesign', busy: false },
    { id: 50, title: 'Prototype a card', label: 'designer', parentConversationId: 40, busy: false },
  ]
  const landed = await landings(cwd, from, to, conversations)
  expect(landed.map(({ conversation, title }) => ({ conversation, title }))).toEqual([
    { conversation: 60, title: 'skills: chip' },
    { conversation: undefined, title: 'hand edit' },
    { conversation: 40, title: 'Answer card redesign' },
  ])
  const build = { id: 'b2', generation: 3, history: [] } as never
  expect(buildNote(build, 'b1', landed)).toBe(
    `Build changed: b1 → b2 · generation 3 · landed: skills: chip (#60), hand edit (${landed[1].sha.slice(0, 7)}), Answer card redesign (#40)`,
  )
})
