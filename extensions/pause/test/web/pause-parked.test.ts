import type { TaskGraph } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { parkedConversations } from '../../parked.ts'

const task = (id: number, conversationId: number, status: string, background = false) => ({
  id,
  kind: 'pi.generation',
  conversationId,
  background,
  abortRequested: false,
  state: { status, phase: 'x' },
  conversations: [],
})

it('parks a conversation whose foreground work is held, not one whose work still executes', () => {
  const graph = {
    tasks: {
      1: task(1, 10, 'pending'),
      2: task(2, 20, 'waiting'),
      3: task(3, 20, 'running'),
      4: task(4, 30, 'pending', true),
    },
  } as unknown as TaskGraph
  // #10 waits on Play; #20's bash still runs; #30 only has background work.
  expect([...parkedConversations(graph, true)]).toEqual([10])
  expect([...parkedConversations(graph, false)]).toEqual([])
})
