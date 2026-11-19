import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../../lib/actions.ts'
import { isMissing, meansNone } from '../../../lib/errors.ts'
import { git } from '../../../lib/git.ts'
import { ProgressAction } from './refs.ts'
import type { Entry, Live, PreviewWeek } from './refs.ts'

export default defineExtension({ name: 'solid-progress' })

const DATA = 'docs/frontend-progress.json'

const frontend = (file: string) =>
  !/(^|\/)test\//.test(file) &&
  (file.startsWith('web/src/') || /^extensions\/[^/]+\/.*\.tsx$/.test(file)) &&
  /\.(tsx?|css)$/.test(file)

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
      if (file.endsWith('.tsx') && !file.endsWith('.solid.tsx') && !glue) counts.reactViews++
    }),
  )
  return [...byName]
    .map(([name, { react, solid, reactViews }]) => ({
      name,
      react,
      solid,
      status:
        solid === 0
          ? ('react' as const)
          : reactViews === 0
            ? ('solid' as const)
            : ('partly' as const),
    }))
    .toSorted(
      (a, b) =>
        Number(a.status === 'react') - Number(b.status === 'react') ||
        b.react + b.solid - (a.react + a.solid),
    )
}

async function coordinators(root: string, commits: string[]) {
  const found = await Promise.all(
    commits.map((commit) =>
      git(
        root,
        'log',
        '-1',
        '--format=%(trailers:key=Ultimate-Conversation,valueonly)',
        commit,
      ).catch(meansNone),
    ),
  )
  return found.map((value) => (value && /^\d+$/.test(value) ? Number(value) : undefined))
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
  const ids = await coordinators(
    root,
    entries.map((entry) => entry.commit),
  )
  return {
    entries: entries.map((entry, index) => ({ ...entry, coordinator: ids[index] })),
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
