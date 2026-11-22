import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing } from './errors.ts'

type Folder = { name: string; path: string; enabled: boolean }

const contracts = [
  ['api.ts', 'the server contract: services, extension points, documents'],
  [
    'refs.ts',
    'the browser contract: documents, actions (call them with ultimate.action) and events',
  ],
] as const

export function apiSummary(text: string) {
  const header = /^\/\*\*([\s\S]*?)\*\//
    .exec(text.trimStart())?.[1]
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (header && /^.*?[.!?](?=\s|$)/.exec(header)?.[0]) || ''
}

async function read(folder: Folder) {
  const found = await Promise.all(
    contracts.map(async ([file, role]) => {
      try {
        return [{ file, role, text: await readFile(join(folder.path, file), 'utf8') }]
      } catch (error) {
        if (!isMissing(error)) throw error
        return []
      }
    }),
  )
  return found.flat()
}

export async function apiSummaries(folders: readonly Folder[]) {
  const found = await Promise.all(
    folders
      .filter((folder) => folder.enabled)
      .map(async (folder) => {
        const [first] = await read(folder)
        return first ? [{ name: folder.name, summary: apiSummary(first.text) }] : []
      }),
  )
  return found.flat().toSorted((a, b) => a.name.localeCompare(b.name))
}

export async function contractOutline(folder: Folder) {
  const files = await read(folder)
  const events = files.flatMap(({ text }) =>
    [...text.matchAll(/defineEvent\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([\w.-]+)['"]/g)].map(
      (match) => match[1],
    ),
  )
  return { summary: files[0] ? apiSummary(files[0].text) : '', events: [...new Set(events)] }
}

export async function apiSource(folders: readonly Folder[], name: string) {
  const folder = folders.find((candidate) => candidate.enabled && candidate.name === name)
  const files = folder ? await read(folder) : []
  if (files.length)
    return files
      .map(({ file, role, text }) => `// ${name}/${file}: ${role}\n${text.trimEnd()}\n`)
      .join('\n')
  const known = (await apiSummaries(folders)).map((api) => api.name)
  throw new Error(
    `No enabled extension "${name}" with an api.ts or refs.ts; known: ${known.join(', ') || 'none'}`,
  )
}
