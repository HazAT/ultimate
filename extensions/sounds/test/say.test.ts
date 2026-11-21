import { expect, it, vi } from 'vitest'
import { actions } from '../server.ts'
import type { SpeechService } from '../../speech/api.ts'
import type { ActionContext } from '../../../server/actions.ts'

const context = (
  speak?: SpeechService['speak'],
  sounds = {},
  signal = new AbortController().signal,
) =>
  ({
    host: {
      userHome: '/nonexistent-home',
      projectSettings: async () => ({ sounds }),
      want: () => speak && { speak },
    },
    signal,
  }) as unknown as ActionContext

it('has the speech service voice a line on the narrator model, and leaves it to the browser without one', async () => {
  const speak = vi.fn<SpeechService['speak']>(async () => ({
    audio: 'AQID',
    mimeType: 'audio/wav',
  }))
  expect(await actions.say({ text: 'Landed: sketch tool.' }, context(speak))).toEqual({
    audio: 'AQID',
  })
  expect(speak).toHaveBeenCalledWith(
    {
      text: 'Landed: sketch tool.',
      openai: expect.objectContaining({ model: 'gpt-realtime-2.1-mini', voice: 'marin' }),
      timeoutMs: 20_000,
    },
    expect.any(AbortSignal),
  )
  expect(await actions.say({ text: 'Landed: sketch tool.' }, context())).toEqual({ audio: null })
})

it('keeps the narrator on the browser voice with sounds.voice off, without asking the speech service', async () => {
  const speak = vi.fn<SpeechService['speak']>()
  expect(
    await actions.say({ text: 'Landed: sketch tool.' }, context(speak, { voice: 'off' })),
  ).toEqual({ audio: null })
  expect(speak).not.toHaveBeenCalled()
})
