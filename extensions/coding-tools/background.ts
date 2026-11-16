import type { ConversationId } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, inProcess, rebuiltOnOpen } from '../../lib/errors.ts'
import { spawnGroup, stopGroup, sweepPidFiles } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

type Host = Pick<ExtensionHost, 'home' | 'notice'>

const groups = (home: string) => join(home, 'background')
const conversationGroups = (home: string, id: ConversationId) => join(groups(home), String(id))
const startedByThisProcess = (name: string) => name.startsWith(`${process.pid}-`)
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

export async function startBackground(
  host: Host,
  conversation: ConversationId,
  cwd: string,
  command: string,
) {
  const directory = conversationGroups(host.home, conversation)
  await mkdir(directory, { recursive: true })
  const name = `${process.pid}-${randomUUID()}`
  const pidFile = join(directory, `${name}.pid`)
  const log = join(directory, `${name}.log`)
  await writeFile(log, '')
  const group = spawnGroup('bash', ['-c', `exec </dev/null >>${quoted(log)} 2>&1\n${command}`], {
    cwd,
    pidFile,
  })
  const { pid } = group.child
  if (pid === undefined) throw new Error('The background command did not start')
  group.child.stdout.resume()
  group.child.stderr.resume()
  inProcess(
    'this process owns the group until it exits; a restart sweeps what it recorded',
    group.ended
      .then(() => stopGroup(pid, { pidFile, leader: group }))
      .catch((error: unknown) => host.notice(`Background group ${pid}: ${String(error)}`)),
  )
  return { pgid: pid, log }
}

async function filesIn(directory: string) {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function sweepConversations(
  host: Host,
  ids: string[],
  keep: (name: string) => boolean = () => false,
) {
  for (const id of ids) {
    const directory = join(groups(host.home), id)
    await sweepPidFiles(directory, keep)
    for (const file of await filesIn(directory))
      if (!keep(file)) await rm(join(directory, file), { force: true })
    if (!(await filesIn(directory)).length) await rm(directory, { recursive: true, force: true })
  }
}

export function stopConcluded(host: Host, ids: ConversationId[]) {
  rebuiltOnOpen(
    "a restart's open stops every group an earlier process recorded",
    sweepConversations(host, ids.map(String)).catch((error: unknown) =>
      host.notice(`Stopping background processes of concluded conversations: ${String(error)}`),
    ),
  )
}

export const sweepEarlierProcesses = (host: Host) =>
  filesIn(groups(host.home))
    .then((ids) => sweepConversations(host, ids, startedByThisProcess))
    .catch((error: unknown) =>
      host.notice(`Stopping background processes an earlier Ultimate left: ${String(error)}`),
    )
