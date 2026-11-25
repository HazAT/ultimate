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
  const [first, setFirst] = createSignal<HTMLElement>()
  const [second, setSecond] = createSignal<HTMLElement>()
  renderSolid(() => {
    useSpokenText(
      () => [first(), second()].filter((element) => element !== undefined),
      () => ({
        key: 'reply',
        spans: sentences.map((sentence) => sentence.text),
        play,
      }),
    )
    return (
      <>
        <div class="markdown" ref={setFirst}>
          <p>
            One muted. Two is <strong>bold</strong> here.
          </p>
        </div>
        <div data-tool-call-id="call-1">One muted.</div>
        <div class="markdown" ref={setSecond}>
          <p>Three follows.</p>
        </div>
      </>
    )
  })
  flush()
}

it('marks the sentence the player speaks across the reply’s messages, by its place when sentences were skipped; a click plays from a sentence only while the player has the reply', async () => {
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

  const paragraph = document.querySelector('p')!
  paragraph.replaceWith(paragraph.cloneNode(true))
  await Promise.resolve()
  expect(spoken()).toEqual(['Two is bold here.'])
  expect(highlights.get('read-aloud')!.values().next().value!.startContainer.isConnected).toBe(true)

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
    useSpokenText(
      () => (element() ? [element()!] : []),
      () => ({
        key: 'repeat',
        spans: repeated.map((sentence) => sentence.text),
      }),
    )
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

it('a reply shown in two transcripts at once, the voice panel and its conversation, is marked in both', () => {
  const view = () => {
    const [element, setElement] = createSignal<HTMLElement>()
    renderSolid(() => {
      useSpokenText(
        () => (element() ? [element()!] : []),
        () => ({ key: 'twice', spans: sentences.map((sentence) => sentence.text) }),
      )
      return <p ref={setElement}>One muted. Two is bold here. Three follows.</p>
    })
  }
  view()
  view()
  flush()
  speech.load('twice', sentences, false)
  speech.play(1)
  const marked = [...highlights.get('read-aloud')!]
  expect(marked.map(String)).toEqual(['Two is bold here.', 'Two is bold here.'])
  expect(marked[0].startContainer).not.toBe(marked[1].startContainer)
  speech.stop()
})
