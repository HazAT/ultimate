import type { ConversationId } from '@earendil-works/pi-durable'
import type { Thread } from './refs.ts'

export const threadPrompt = (path: string, absolute: string) =>
  `The user's thread for reading ${path} (${absolute}). Their comments on this file come here from the Read surface ` +
  `as reviews, one per Send, each comment naming the lines it covers; work through them in that file. Comments on ` +
  `other files go to their own threads.`

export const threadTitle = (path: string) => `Read: ${path}`

export type ThreadDeps = {
  find(absolute: string): Promise<Thread | undefined>
  branch(input: {
    from: ConversationId
    prompt: string
    title: string
    deliver: false
  }): Promise<{ id: ConversationId }>
  record(absolute: string, thread: Thread): Promise<void>
}

const starting = new Map<string, Promise<{ thread: Thread; started: boolean }>>()

export function threadFor(
  deps: ThreadDeps,
  file: { absolute: string; path: string },
  from: ConversationId,
) {
  const running = starting.get(file.absolute)
  if (running) return running
  const run = (async () => {
    const found = await deps.find(file.absolute)
    if (found) return { thread: found, started: false }
    const { id } = await deps.branch({
      from,
      prompt: threadPrompt(file.path, file.absolute),
      title: threadTitle(file.path),
      deliver: false,
    })
    const thread = { id, from, path: file.path }
    await deps.record(file.absolute, thread)
    return { thread, started: true }
  })().finally(() => starting.delete(file.absolute))
  starting.set(file.absolute, run)
  return run
}
