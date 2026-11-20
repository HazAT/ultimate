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

const isGlue = (file: string, text: string) =>
  file.endsWith('/web.tsx') && text.includes('island(') && !text.includes('className=')

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
      if (isReactView(file, isGlue(file, text))) counts.reactViews++
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
  const [listed, islands] = await Promise.all([
    git(root, 'ls-tree', '-r', '--name-only', commit, '--', 'extensions'),
    git(root, 'grep', '-F', '-l', 'island(', commit, '--', 'extensions/*/web.tsx').catch(
      (error: unknown) => {
        if ((error as { code?: unknown }).code === 1) return undefined
        throw error
      },
    ),
  ])
  const tree = listed.split('\n').filter(frontend)
  const webs = await Promise.all(
    (islands ? islands.split('\n') : []).map(async (found) => {
      const file = found.slice(commit.length + 1)
      return [file, await git(root, 'show', `${commit}:${file}`)] as const
    }),
  )
  const glue = new Set(webs.filter(([file, text]) => isGlue(file, text)).map(([file]) => file))
  const byName = new Map<string, { solid: boolean; reactViews: number }>()
  for (const file of tree) {
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

async function step(root: string, entry: Entry): Promise<Entry> {
  const log = await git(
    root,
    'log',
    '-1',
    '--format=%s%x00%(trailers:key=Ultimate-Conversation,valueonly)',
    entry.commit,
  ).catch(meansNone)
  if (log === undefined) return entry
  const [subject, trailer] = log.split('\0')
  return {
    ...entry,
    summary: entry.summary ?? subject,
    coordinator: /^\d+$/.test(trailer) ? Number(trailer) : undefined,
    statuses: await statuses(root, entry.commit),
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
  return {
    entries: await Promise.all(entries.map((entry) => step(root, entry))),
    previewUsage,
  }
}

export const actions = {
  progress: implementAction(ProgressAction, async (_args, { host }) => {
    const [data, split] = await Promise.all([series(host.projectRoot), live(host.projectRoot)])
    return data
      ? { ...data, live: split }
      : { entries: [], previewUsage: [], live: split, missing: DATA }
  }),
}
