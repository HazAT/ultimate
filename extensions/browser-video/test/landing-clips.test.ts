import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ActionContext } from '../../../server/actions.ts'
import { actions } from '../server.ts'

it('keeps the exact clip chosen for a question alongside the capped recent clips on landing', async () => {
  const branch = 8 as ConversationId
  const clipAt = (index: number) => ({
    id: `46136758-0811-4be8-9a87-81b049be2ba${index.toString(16)}`,
    title: `Recording ${index}`,
  })
  const clips = Array.from({ length: 14 }, (_, index) => clipAt(index))
  const ctx = {
    signal: new AbortController().signal,
    host: {
      want: () => ({
        async find(id: string) {
          const clip = clips.find((candidate) => candidate.id === id)
          return clip && { ...clip, conversation: branch }
        },
      }),
      harness: () => ({
        snapshot: async () => ({ ids: [clips[0].id] }),
        conversation: async () => ({
          entries: async () => ({
            items: clips.toReversed().map((video) => ({
              kind: 'pi.tool-result',
              conversationId: branch,
              model: [{ role: 'toolResult', toolName: 'browser_video', details: { video } }],
            })),
          }),
        }),
      }),
    },
  } as unknown as ActionContext
  const shown = await actions.landingClips({ conversation: branch }, ctx)
  expect(shown).toEqual([clips[0], ...clips.slice(2).toReversed()])
})
