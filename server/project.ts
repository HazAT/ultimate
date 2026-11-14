import { basename, join } from 'node:path'
import { readFile, readdir, writeFile, rename } from 'node:fs/promises'
import type { ConversationSummary } from '../shared/protocol.ts'
import { alive, readOwner } from '../lib/lock.ts'
import { debounce } from '../lib/timers.ts'
import { meansNone } from '../lib/errors.ts'

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
export async function projects(userHome: string, currentHome: string): Promise<ProjectInfo[]> {
  const directory = join(userHome, '.ultimate/projects')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const homes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
  if (!homes.includes(currentHome)) homes.push(currentHome)
  return Promise.all(
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
}

/** Debounced, serialized snapshots; busy/ownership fields never enter the public index. */
export function conversationIndex(home: string) {
  let latest = '[]'
  let written: string | undefined
  let writing = Promise.resolve()
  const schedule = debounce(1000, () => {
    void flush().catch((error: unknown) => console.error('Conversation index:', error))
  })
  const flush = () => {
    schedule.cancel()
    writing = writing.then(async () => {
      if (latest === written) return
      const value = latest
      await atomicJson(join(home, 'conversations.json'), value)
      written = value
    })
    return writing
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
