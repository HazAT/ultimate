import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { spliced } from '../../../../web/src/app/queued.ts'

const status = vi.hoisted(() => ({ data: undefined as unknown }))
const busy = vi.hoisted(() => ({ value: false }))
vi.mock('@/sdk', () => ({
  api: {},
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: String,
  events: { emit: () => {} },
  formatKeys: (keys: string) => [keys.split('+').map((part) => part.toUpperCase())],
  getConversation: () => ({ busy: busy.value }),
  insertIntoComposer: () => {},
  useAction: () => ({ data: status.data, loading: false, refetch: async () => undefined }),
  useConversation: () => ({ id: 7 }),
  useEvent: () => {},
  useNow: () => 0,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))

async function button(data: unknown) {
  status.data = data
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } })
  vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
  const facet = (await import('../../web.tsx')).default as unknown as {
    slots: { 'composer.actions': ComponentType[] }
  }
  const html = renderToStaticMarkup(createElement(facet.slots['composer.actions'][0]))
  vi.unstubAllGlobals()
  return html
}

type Command = {
  id: string
  when?: (context: { conversationId?: number }) => boolean
  run: (context: { conversationId?: number }) => void
}

/**
 * The facet's commands and `registerVoice`, standing in for a mounted button without a DOM. `unsupported()` (behind
 * `voice.toggle`'s `when`) reads `window`/`navigator`/`MediaRecorder` lazily, at call time, so the stubs stay until
 * the caller is done and restores them.
 */
async function commands() {
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } })
  vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
  const module = (await import('../../web.tsx')) as unknown as {
    default: { commands: Command[] }
    registerVoice: (
      id: number,
      controls: { toggle: () => void; cancel: () => void; recording: boolean },
    ) => () => void
  }
  return {
    commands: module.default.commands,
    registerVoice: module.registerVoice,
    restore: () => vi.unstubAllGlobals(),
  }
}

it('dims the mic and says why while no OpenAI key is set', async () => {
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  const html = await button({ available: false, reason })
  expect(html).toContain('data-voice="blocked"')
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain(`aria-label="${reason}"`)
})

it('offers the mic once a key is set', async () => {
  const html = await button({ available: true })
  expect(html).toContain('data-voice="idle"')
  expect(html).toContain('aria-label="Voice input"')
  expect(html).toContain('aria-disabled="false"')
})

it('voice.toggle calls the registered button for the context conversation, and only that one', async () => {
  const { commands: list, registerVoice, restore } = await commands()
  const toggle = commands_find(list, 'voice.toggle')
  const calls: number[] = []
  const withdraw7 = registerVoice(7, {
    toggle: () => calls.push(7),
    cancel: () => {},
    recording: false,
  })
  const withdraw9 = registerVoice(9, {
    toggle: () => calls.push(9),
    cancel: () => {},
    recording: false,
  })
  toggle.run({ conversationId: 7 })
  toggle.run({ conversationId: 9 })
  toggle.run({ conversationId: 123 })
  expect(calls).toEqual([7, 9])
  withdraw7()
  withdraw9()
  restore()
})

it('voice.toggle is hidden once no button is mounted for that conversation, or the context has none', async () => {
  const { commands: list, registerVoice, restore } = await commands()
  const toggle = commands_find(list, 'voice.toggle')
  expect(toggle.when?.({ conversationId: 7 })).toBe(false)
  const withdraw = registerVoice(7, { toggle: () => {}, cancel: () => {}, recording: false })
  expect(toggle.when?.({ conversationId: 7 })).toBe(true)
  expect(toggle.when?.({ conversationId: undefined })).toBe(false)
  withdraw()
  expect(toggle.when?.({ conversationId: 7 })).toBe(false)
  restore()
})

it('voice.toggle hides once the browser cannot record, even with a button registered', async () => {
  const { commands: list, registerVoice, restore } = await commands()
  const toggle = commands_find(list, 'voice.toggle')
  const withdraw = registerVoice(7, { toggle: () => {}, cancel: () => {}, recording: false })
  expect(toggle.when?.({ conversationId: 7 })).toBe(true)
  vi.stubGlobal('window', { isSecureContext: false })
  expect(toggle.when?.({ conversationId: 7 })).toBe(false)
  withdraw()
  restore()
})

it('voice.cancel fires only while a recording is live and the conversation is idle; it never fights agent.stop', async () => {
  const { commands: list, registerVoice, restore } = await commands()
  const cancel = commands_find(list, 'voice.cancel')
  let cancelled = false
  const withdraw = registerVoice(7, {
    toggle: () => {},
    cancel: () => (cancelled = true),
    recording: true,
  })
  expect(cancel.when?.({ conversationId: 7 })).toBe(true)
  busy.value = true
  expect(cancel.when?.({ conversationId: 7 })).toBe(false)
  busy.value = false
  cancel.run({ conversationId: 7 })
  expect(cancelled).toBe(true)
  withdraw()
  expect(cancel.when?.({ conversationId: 7 })).toBe(false)
  restore()
})

function commands_find(list: Command[], id: string): Command {
  const found = list.find((command) => command.id === id)
  if (!found) throw new Error(`No command ${id}`)
  return found
}

async function voiceModule() {
  return (await import('../../web.tsx')) as unknown as {
    handleTranscription: typeof import('../../web.tsx').handleTranscription
    entersSend: typeof import('../../web.tsx').entersSend
  }
}

function fakeEffects() {
  const calls: string[] = []
  return {
    calls,
    insert: (text: string) => calls.push(`insert:${text}`),
    submit: () => calls.push('submit'),
    error: (message: string) => calls.push(`error:${message}`),
  }
}

it("Send transcribes, inserts the transcript, and submits (the composer's own Send)", async () => {
  const { handleTranscription } = await voiceModule()
  const effects = fakeEffects()
  await handleTranscription(async () => ({ text: 'buy milk' }), true, effects)
  expect(effects.calls).toEqual(['insert:buy milk', 'submit'])
})

it('Stop transcribes and inserts, unsent, for editing', async () => {
  const { handleTranscription } = await voiceModule()
  const effects = fakeEffects()
  await handleTranscription(async () => ({ text: 'buy milk' }), false, effects)
  expect(effects.calls).toEqual(['insert:buy milk'])
})

it('a failed transcription sends nothing: no insert, no submit, just the error', async () => {
  const { handleTranscription } = await voiceModule()
  const effects = fakeEffects()
  await handleTranscription(async () => Promise.reject(new Error('network down')), true, effects)
  expect(effects.calls).toEqual(['error:Error: network down'])
})

it('an empty transcription sends nothing either, Send or Stop', async () => {
  const { handleTranscription } = await voiceModule()
  for (const send of [true, false]) {
    const effects = fakeEffects()
    await handleTranscription(async () => ({ text: '' }), send, effects)
    expect(effects.calls).toEqual(['error:No speech heard'])
  }
})

it("Enter sends while recording, in that conversation's own composer, and leaves Enter alone otherwise", async () => {
  const { entersSend } = await voiceModule()
  const enter = {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
  }
  expect(entersSend(enter, '7', 7, true)).toBe(true)
  // Not recording: Enter is untouched.
  expect(entersSend(enter, '7', 7, false)).toBe(false)
  // A different conversation's composer, even while this one records.
  expect(entersSend(enter, '9', 7, true)).toBe(false)
  // No composer in focus (the shortcut's own conversationId, not a textarea).
  expect(entersSend(enter, undefined, 7, true)).toBe(false)
  // A modifier or an IME composition: not a plain Enter.
  expect(entersSend({ ...enter, shiftKey: true }, '7', 7, true)).toBe(false)
  expect(entersSend({ ...enter, metaKey: true }, '7', 7, true)).toBe(false)
  expect(entersSend({ ...enter, isComposing: true }, '7', 7, true)).toBe(false)
  // Any other key, recording or not.
  expect(entersSend({ ...enter, key: 'a' }, '7', 7, true)).toBe(false)
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
