import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises'
import type { ConversationSummary } from '../shared/protocol.ts'
import { alive, readOwner } from '../lib/lock.ts'
import { projectHome } from '../lib/project-paths.ts'
import { debounce } from '../lib/timers.ts'
import { rebuiltOnOpen, meansNone } from '../lib/errors.ts'

export type ProjectConversation = Pick<
  ConversationSummary,
  'id' | 'title' | 'label' | 'cwd' | 'inputAt' | 'answerAt'
>
export interface ProjectInfo {
  root?: string
  name: string
  home: string
  openedAt?: number
  current: boolean
  running?: { pid: number; url: string }
  conversations: ProjectConversation[]
}

export async function writeProject(home: string, root: string) {
  await atomicJson(
    join(home, 'project.json'),
    JSON.stringify({ root, name: basename(root), openedAt: Date.now() }),
  )
}
export async function atomicJson(path: string, value: string) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, value + '\n')
  await rename(temporary, path)
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
const localHomeFile = (home: string) => createHash('sha256').update(home).digest('hex') + '.json'
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes('\0') &&
  isAbsolute(value) &&
  resolve(value) === value

export async function registerLocalHome(userHome: string, home: string, root: string) {
  home = resolve(home)
  root = resolve(root)
  if (!absolutePath(home) || !absolutePath(root)) throw new Error('Invalid local project paths')
  if (home === resolve(projectHome(root, userHome))) return
  const directory = join(userHome, '.ultimate/local-homes')
  await mkdir(directory, { recursive: true })
  await atomicJson(join(directory, localHomeFile(home)), JSON.stringify({ home, root }))
}

async function localHomes(userHome: string) {
  const directory = join(userHome, '.ultimate/local-homes')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const homes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const record = await readJson<{ home?: unknown; root?: unknown }>(
          join(directory, entry.name),
        )
        if (
          !absolutePath(record?.home) ||
          !absolutePath(record?.root) ||
          entry.name !== localHomeFile(record.home)
        )
          return []
        const project = await readJson<{ root?: unknown; name?: unknown }>(
          join(record.home, 'project.json'),
        )
        return project?.root === record.root && project.name === basename(record.root)
          ? [record.home]
          : []
      }),
  )
  return homes.flat()
}

export async function projects(userHome: string, currentHome: string): Promise<ProjectInfo[]> {
  const directory = join(userHome, '.ultimate/projects')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const homes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
  if (!homes.includes(currentHome)) homes.push(currentHome)
  const local = new Set<string>()
  for (const home of await localHomes(userHome))
    if (!homes.some((known) => resolve(known) === home)) {
      homes.push(home)
      local.add(home)
    }
  const listed = await Promise.all(
    homes.toSorted().map(async (home) => {
      const project = await readJson<{ root: string; name: string; openedAt: number }>(
        join(home, 'project.json'),
      )
      const lock = await readOwner(join(home, 'ultimate.lock')).catch(meansNone)
      return {
        ...project,
        name: project?.name ?? basename(home),
        home,
        current: home === currentHome,
        ...(lock?.port && alive(lock.pid)
          ? { running: { pid: lock.pid, url: `http://127.0.0.1:${lock.port}` } }
          : {}),
        conversations:
          (await readJson<ProjectConversation[]>(join(home, 'conversations.json'))) ?? [],
      }
    }),
  )
  return listed.filter(
    (item) =>
      !local.has(item.home) ||
      item.current ||
      item.running ||
      !listed.some(
        (other) =>
          other.root === item.root && (!local.has(other.home) || other.current || other.running),
      ),
  )
}

export function conversationIndex(home: string) {
  let latest = '[]'
  let written: string | undefined
  let serializedSnapshots = Promise.resolve()
  const publicIndexDebounceMs = 1000
  const schedule = debounce(publicIndexDebounceMs, () => {
    rebuiltOnOpen(
      'the next summary change rebuilds conversations.json',
      flush().catch((error: unknown) => console.error('Conversation index:', error)),
    )
  })
  const flush = () => {
    schedule.cancel()
    serializedSnapshots = serializedSnapshots.then(async () => {
      if (latest === written) return
      const value = latest
      await atomicJson(join(home, 'conversations.json'), value)
      written = value
    })
    return serializedSnapshots
  }
  return {
    update(summaries: ConversationSummary[]) {
      latest = JSON.stringify(
        summaries
          .filter(
            (item) => item.parentConversationId === undefined && item.ownerTaskId === undefined,
          )
          .map(({ id, title, label, cwd, inputAt, answerAt }) => ({
            id,
            title,
            label,
            cwd,
            inputAt,
            answerAt,
          })),
      )
      schedule()
    },
    flush,
  }
}
