import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('@/sdk/solid', async () => {
  const solid = await import('solid-js')
  return {
    api: { action: () => new Promise(() => undefined) },
    errorMessage: String,
    ROOT: 1,
    useUiState: (key: string, initial: unknown) =>
      solid.createSignal<unknown>(key === 'ext.read-aloud.voice' ? 'system' : initial),
  }
})
const said: string[] = []
vi.stubGlobal('speechSynthesis', {
  cancel() {},
  speak: (utterance: { text: string }) => said.push(utterance.text),
  getVoices: () => [{ name: 'Test voice' }],
  addEventListener() {},
})
vi.stubGlobal(
  'SpeechSynthesisUtterance',
  class {
    text: string
    constructor(text: string) {
      this.text = text
    }
    addEventListener() {}
  },
)
const highlights = new Map<string, Set<Range>>()
vi.stubGlobal('CSS', { highlights })
vi.stubGlobal(
  'Highlight',
  class extends Set<Range> {
    priority = 0
  },
)
const hits = vi.hoisted(() => ({ text: '' }))
Range.prototype.getClientRects = function (this: Range) {
  const rects = this.toString() === hits.text ? [new DOMRect(0, 0, 100, 20)] : []
  return rects as unknown as DOMRectList
}

const { speech, splitReply, useSpokenText } = await import('../../ui.solid.tsx')

const reply = 'One muted. Two is **bold** here. Three follows.'
const { sentences } = splitReply([{ text: reply, final: true }])
const spoken = () => [...(highlights.get('read-aloud') ?? [])].map(String)

function mount(play: (span: number) => void) {
  const [element, setElement] = createSignal<HTMLElement>()
  renderSolid(() => {
    useSpokenText(element, () => ({
      key: 'reply',
      spans: sentences.map((sentence) => sentence.text),
      clickable: true,
      play,
    }))
    return (
      <div class="markdown" ref={setElement}>
        <p>
          One muted. Two is <strong>bold</strong> here. Three follows.
        </p>
      </div>
    )
  })
  flush()
}

it('marks the sentence the player speaks, by its place when sentences were skipped; a click plays from a sentence only while the player has the reply', () => {
  const play = vi.fn<(span: number) => void>()
  mount(play)
  speech.load('reply', [sentences[0]], true)
  speech.play(0)
  expect(spoken()).toEqual(['One muted.'])

  speech.push('reply', sentences[2])
  speech.play(1)
  expect(spoken()).toEqual(['Three follows.'])

  speech.load('reply', [sentences[1]], false)
  speech.play(0)
  expect(spoken()).toEqual(['Two is bold here.'])

  hits.text = 'Three follows.'
  document.querySelector('strong')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(play).toHaveBeenCalledWith(2)

  speech.stop()
  expect(spoken()).toEqual([])
  document.querySelector('strong')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(play).toHaveBeenCalledTimes(1)
})

it('a repeated sentence spoken after its twin was muted marks its own place', () => {
  const repeated = splitReply([{ text: 'Start. Again. Again.', final: true }]).sentences
  const [element, setElement] = createSignal<HTMLElement>()
  renderSolid(() => {
    useSpokenText(element, () => ({
      key: 'repeat',
      spans: repeated.map((sentence) => sentence.text),
    }))
    return (
      <p ref={setElement}>
        Start. Again. <em>Again.</em>
      </p>
    )
  })
  flush()
  speech.load('repeat', [repeated[0], repeated[2]], false)
  speech.play(1)
  const [range] = highlights.get('read-aloud')!
  expect(String(range)).toBe('Again.')
  expect(range.startContainer.parentElement?.tagName).toBe('EM')
  speech.stop()
})
