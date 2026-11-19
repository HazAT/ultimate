import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../../lib/actions.ts'
import { isMissing, meansNone } from '../../../lib/errors.ts'
import { git } from '../../../lib/git.ts'
import { ProgressAction } from './refs.ts'
import type { Entry, Live, PreviewWeek, Status } from './refs.ts'

export default defineExtension({ name: 'solid-progress' })

const DATA = 'docs/frontend-progress.json'

const frontend = (file: string) =>
  !/(^|\/)test\//.test(file) &&
  (file.startsWith('web/src/') || /^extensions\/[^/]+\/.*\.tsx$/.test(file)) &&
  /\.(tsx?|css)$/.test(file)

const status = (solid: boolean, reactViews: number): Status =>
  !solid ? 'react' : reactViews === 0 ? 'solid' : 'partly'

const isReactView = (file: string, glue: boolean) =>
  file.endsWith('.tsx') && !file.endsWith('.solid.tsx') && !glue

async function live(root: string): Promise<Live[]> {
  const files = (await git(root, 'ls-files')).split('\n').filter(frontend)
  const byName = new Map<string, { react: number; solid: number; reactViews: number }>()
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(root, file), 'utf8').catch((error: unknown) => {
        if (isMissing(error)) return ''
        throw error
      })
      const lines = text.split('\n').filter((line) => line.trim()).length
      const name = file.startsWith('web/src/') ? 'web/src' : file.split('/')[1]
      const counts = byName.get(name) ?? { react: 0, solid: 0, reactViews: 0 }
      byName.set(name, counts)
      if (file.endsWith('.solid.tsx')) counts.solid += lines
      else counts.react += lines
      const glue = file.endsWith('/web.tsx') && text.includes('island(')
      if (isReactView(file, glue)) counts.reactViews++
    }),
  )
  return [...byName].map(([name, { react, solid, reactViews }]) => ({
    name,
    react,
    solid,
    status: status(solid > 0, reactViews),
  }))
}

async function statuses(root: string, commit: string) {
  const [tree, islands] = await Promise.all([
    git(root, 'ls-tree', '-r', '--name-only', commit, '--', 'extensions'),
    git(root, 'grep', '-l', 'island(', commit, '--', 'extensions/*/web.tsx').catch(meansNone),
  ])
  const glue = new Set(islands?.split('\n').map((line) => line.slice(commit.length + 1)))
  const byName = new Map<string, { solid: boolean; reactViews: number }>()
  for (const file of tree.split('\n').filter(frontend)) {
    const name = file.split('/')[1]
    const counts = byName.get(name) ?? { solid: false, reactViews: 0 }
    byName.set(name, counts)
    if (file.endsWith('.solid.tsx')) counts.solid = true
    if (isReactView(file, glue.has(file))) counts.reactViews++
  }
  return Object.fromEntries(
    [...byName].map(([name, { solid, reactViews }]) => [name, status(solid, reactViews)]),
  )
}

async function step(root: string, commit: string) {
  const trailer = await git(
    root,
    'log',
    '-1',
    '--format=%(trailers:key=Ultimate-Conversation,valueonly)',
    commit,
  ).catch(meansNone)
  if (trailer === undefined) return {}
  return {
    coordinator: /^\d+$/.test(trailer) ? Number(trailer) : undefined,
    statuses: await statuses(root, commit),
  }
}

async function series(
  root: string,
): Promise<{ entries: Entry[]; previewUsage: PreviewWeek[] } | undefined> {
  const text = await readFile(join(root, DATA), 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (text === undefined) return undefined
  const { entries, previewUsage = [] } = JSON.parse(text) as {
    entries: Entry[]
    previewUsage?: PreviewWeek[]
  }
  const steps = await Promise.all(entries.map((entry) => step(root, entry.commit)))
  return {
    entries: entries.map((entry, index) => ({ ...entry, ...steps[index] })),
    previewUsage,
  }
}

export const actions = {
  progress: implementAction(ProgressAction, async (_args, { host }) => {
    const [data, split] = await Promise.all([series(host.projectRoot), live(host.projectRoot)])
    if (!data) return { entries: [], previewUsage: [], live: split, missing: DATA }
    const titles = new Map<number, string | undefined>(
      host.conversations().map((summary) => [summary.id, summary.title]),
    )
    const [baseline, ...steps] = data.entries
    const entries = [
      { ...baseline, coordinator: undefined, summary: baseline.summary ?? 'the baseline' },
      ...steps.map((entry) => ({
        ...entry,
        summary: entry.summary ?? (entry.coordinator ? titles.get(entry.coordinator) : undefined),
      })),
    ]
    return { ...data, entries, live: split }
  }),
}
