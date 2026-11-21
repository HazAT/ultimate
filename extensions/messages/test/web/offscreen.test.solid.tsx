/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { createTranscriptFrame, events, Transcript } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { OffscreenQuestions } from '../../waiting.solid.tsx'

const conversation = parseConversationId(7)
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useConversationId: () => () => conversation,
  useDocOf: () => () => ({
    messages: [{ id: 12, from: 4, to: 'user', state: 'delivered', reply: true }],
  }),
}))

const agent = createAgent()

it('finds a question card mounted after its row and reveals its entry when pressed', async ({
  onTestFinished,
}) => {
  const observers = new Map<string | undefined, (isIntersecting: boolean) => void>()
  const observed = new Set<Element>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private targets: Element[] = []
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        observers.set(options.rootMargin, (isIntersecting) =>
          callback(
            this.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
            this as unknown as IntersectionObserver,
          ),
        )
      }
      observe(target: Element) {
        observed.add(target)
        this.targets.push(target)
      }
      unobserve(target: Element) {
        observed.delete(target)
        this.targets = this.targets.filter((element) => element !== target)
      }
      disconnect() {
        this.targets = []
      }
    },
  )
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const transcript = createTranscriptFrame(() => [
    {
      id: 44,
      conversationId: conversation,
      kind: 'board.asked',
      data: { message: 12 },
    } as unknown as EntryRecord,
  ])
  let scroll!: HTMLDivElement
  const view = renderSolid(() => (
    <Transcript value={transcript.frame}>
      <div ref={scroll}>
        <div>
          <OffscreenQuestions />
        </div>
        <div ref={(content: HTMLDivElement) => transcript.mount({ scroll, content })}>
          <div data-entry-id="44" />
        </div>
      </div>
    </Transcript>
  ))
  const row = view.querySelector('[data-entry-id="44"]')!
  expect([...observed]).toEqual([row])
  const card = document.createElement('div')
  card.dataset.messagePointer = '12'
  row.append(card)
  await Promise.resolve()
  expect([...observed]).toEqual([card])
  const viewport = observers.get(undefined)!
  const extended = observers.get('0px 0px 1000000px 0px')!
  viewport(false)
  extended(true)
  flush()
  const button = agent
    .snapshot()
    .find((entry) => entry.label === 'A question awaits your reply below')
  expect(button).toBeDefined()
  const reveal = vi.fn<(value: unknown) => void>()
  onTestFinished(events.on('ultimate:reveal-entry', reveal))
  expect((await agent.act({ steps: [{ ref: button!.ref, action: 'press' }] })).ok).toBe(true)
  expect(reveal).toHaveBeenCalledWith({ conversationId: conversation, entryId: 44 })
  viewport(true)
  flush()
  expect(view.querySelector('[data-ui="offscreen-questions"] button')).toBeNull()
})
