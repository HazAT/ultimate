import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { ignoring, isMissing } from '../../lib/errors.ts'
import { parseConversationId } from '../../lib/ids.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { LineageApi } from '../lineage/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { checkoutRoots, gitCommonDir, MARKDOWN, resolveMarkdown } from './paths.ts'
import { FilesAction, ReadAction, ThreadAction, ThreadsDoc } from './refs.ts'
import type { Thread } from './refs.ts'
import { threadFor } from './threads.ts'
import type { ThreadDeps } from './threads.ts'

const FILES_LIMIT = 2000

const Threads = defineDoc<{ threads: Record<string, Thread> }>({
  kind: ThreadsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ threads: {} }),
})
export const docs = [Threads]

const fieldOf = (args: unknown, name: string): unknown =>
  args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)[name]
    : undefined

function conversationOf(args: unknown): ConversationId | undefined {
  const value = fieldOf(args, 'conversation')
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('conversation must be a conversation id')
  return parseConversationId(value)
}

async function rootsOf(host: ExtensionHost, conversation?: ConversationId) {
  const index =
    conversation === undefined
      ? undefined
      : await host.harness().snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  return checkoutRoots(host.projectRoot, index?.items[String(conversation)], gitCommonDir)
}

const threadDeps = (host: ExtensionHost): ThreadDeps => ({
  find: (absolute) =>
    host.harness().commit(async (tx) => {
      const thread = (await tx.doc(Threads, ROOT_CONVERSATION_ID)).threads[absolute]
      return thread && (await tx.conversation(thread.id))
        ? { id: thread.id, from: thread.from, path: thread.path }
        : undefined
    }, context),
  branch: (input) => host.need(LineageApi).branch(input, context),
  record: (absolute, thread) =>
    host.harness().commit(async (tx) => {
      ;(await tx.doc(Threads, ROOT_CONVERSATION_ID)).threads[absolute] = thread
    }, context),
})

export const userActions = ['read', 'files', 'thread']

export const actions = {
  read: implementAction(ReadAction, async (args, { host }) => {
    const file = await resolveMarkdown(
      fieldOf(args, 'path'),
      await rootsOf(host, conversationOf(args)),
    )
    const text = await readFile(file.absolute, 'utf8')
    return { path: file.path, absolute: file.absolute, root: file.root, text, mtime: file.mtime }
  }),
  files: implementAction(FilesAction, async (args, ctx) => {
    const [cwd] = (await rootsOf(ctx.host, conversationOf(args))) as [string]
    const { stdout } = await ctx.exec(
      'git',
      ['ls-files', '-co', '--exclude-standard', '--', '*.md', '*.markdown'],
      { cwd },
    )
    const paths = [...new Set(stdout.split('\n').filter((path) => MARKDOWN.test(path)))]
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        mtime: (await stat(join(cwd, path)).catch(ignoring(isMissing)))?.mtimeMs ?? 0,
      })),
    )
    const present = files.filter((file) => file.mtime > 0).toSorted((a, b) => b.mtime - a.mtime)
    return { files: present.slice(0, FILES_LIMIT), truncated: present.length > FILES_LIMIT }
  }),
  thread: implementAction(ThreadAction, async (args, { host }) => {
    const from = conversationOf(args)
    if (from === undefined) throw new Error('Name the conversation the file was opened from')
    const file = await resolveMarkdown(fieldOf(args, 'path'), await rootsOf(host, from))
    const { thread, started } = await threadFor(threadDeps(host), file, from)
    return { ...thread, started }
  }),
}

export default function reader(host: ExtensionHost) {
  host.need(LineageApi)
  host.need(WorkspacesApi)
  return defineExtension({ name: 'reader' })
}
