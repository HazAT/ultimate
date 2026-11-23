import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { parseConversationId } from '../../../lib/ids.ts'
import type { Thread } from '../refs.ts'
import { threadFor } from '../threads.ts'
import type { ThreadDeps } from '../threads.ts'

const id = parseConversationId
const plan = { absolute: '/work/app/docs/plan.md', path: 'docs/plan.md' }
const notes = { absolute: '/work/app/docs/notes.md', path: 'docs/notes.md' }

function world() {
  const threads = new Map<string, Thread>()
  const live = new Set<ConversationId>([id(1), id(7)])
  const branches: Parameters<ThreadDeps['branch']>[0][] = []
  let next = 100
  const deps: ThreadDeps = {
    find: async (absolute) => {
      const thread = threads.get(absolute)
      return thread && live.has(thread.id) ? thread : undefined
    },
    branch: async (input) => {
      branches.push(input)
      const made = id(next++)
      live.add(made)
      return { id: made }
    },
    record: async (absolute, thread) => {
      threads.set(absolute, thread)
    },
  }
  return { deps, threads, live, branches }
}

it('starts a branch of the conversation the file was opened from on the first Send, delivering nothing', async () => {
  const { deps, threads, branches } = world()
  const { thread, started } = await threadFor(deps, plan, id(7))
  expect(started).toBe(true)
  expect(thread).toEqual({ id: 100, from: 7, path: 'docs/plan.md' })
  expect(branches).toHaveLength(1)
  expect(branches[0]).toMatchObject({ from: 7, deliver: false, title: 'Read: docs/plan.md' })
  expect(branches[0].prompt).toContain(
    "The user's thread for reading docs/plan.md (/work/app/docs/plan.md)",
  )
  expect(threads.get(plan.absolute)).toEqual(thread)
})

it('sends later comments on the file to its thread from any conversation; another file gets its own', async () => {
  const { deps, branches } = world()
  const first = await threadFor(deps, plan, id(7))
  const again = await threadFor(deps, plan, id(1))
  expect(again).toEqual({ thread: first.thread, started: false })
  const other = await threadFor(deps, notes, id(7))
  expect(other.thread.id).not.toBe(first.thread.id)
  expect(branches).toHaveLength(2)
})

it('starts one thread for two Sends at once', async () => {
  const { deps, branches } = world()
  const [a, b] = await Promise.all([threadFor(deps, plan, id(7)), threadFor(deps, plan, id(7))])
  expect(a.thread.id).toBe(b.thread.id)
  expect(branches).toHaveLength(1)
})

it('replaces a thread whose conversation is gone with a new branch', async () => {
  const { deps, live, branches } = world()
  const first = await threadFor(deps, plan, id(7))
  live.delete(first.thread.id)
  const next = await threadFor(deps, plan, id(7))
  expect(next.started).toBe(true)
  expect(next.thread.id).not.toBe(first.thread.id)
  expect(branches).toHaveLength(2)
})
