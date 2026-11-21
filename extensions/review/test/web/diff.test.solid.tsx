/** @jsxImportSource @solidjs/web */
import { parsePatchFiles, preloadHighlighter, Virtualizer } from '@pierre/diffs'
import { flush, createSignal, onSettled } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { useDrafts } from '../../drafts.solid.tsx'
import { CommentedDiff } from '../../file-diff.solid.tsx'
import type { Writing } from '../../file-diff.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined) }
})

const theme = { dark: 'vitesse-dark', light: 'vitesse-light' } as const
const patch = [
  'diff --git a/notes.txt b/notes.txt',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n')

function Annotated() {
  const file = parsePatchFiles(patch)[0].files[0]
  const [drafts, update] = useDrafts(() => 'test')
  const [writing, write] = createSignal<Writing>({
    file: file.name,
    range: { start: 1, end: 1, side: 'additions' },
  })
  const virtualizer = new Virtualizer()
  let scroller!: HTMLDivElement
  onSettled(() => {
    virtualizer.setup(scroller)
    return () => virtualizer.cleanUp()
  })
  return (
    <div ref={scroller}>
      <CommentedDiff
        drafts={drafts().comments}
        meta={file}
        onWrite={write}
        options={{ theme }}
        update={update}
        virtualizer={virtualizer}
        writing={writing()}
      />
    </div>
  )
}

it('saves and reopens a draft on the selected line of the native diff', async ({
  onTestFinished,
}) => {
  await preloadHighlighter({ themes: [theme.dark, theme.light], langs: ['text'] })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const container = renderSolid(() => <Annotated />)
  const diff = container.querySelector('diffs-container')!
  const line = 'annotation-additions-1'
  const slot = () => diff.shadowRoot!.querySelector<HTMLSlotElement>(`slot[name="${line}"]`)
  expect(slot()?.assignedElements()[0]?.querySelector('[data-review-composer]')).toBeTruthy()
  const field = diff.querySelector('textarea')!
  field.setRangeText('Keep this heading.')
  field.dispatchEvent(new Event('input', { bubbles: true }))
  flush()
  diff.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  flush()
  const saved = slot()?.assignedElements()[0]?.querySelector('[data-review-draft]')
  expect(saved?.textContent).toContain('Keep this heading.')
  saved?.querySelector<HTMLButtonElement>('[aria-label^="Edit review comment"]')?.click()
  flush()
  expect(diff.querySelector('textarea')?.value).toBe('Keep this heading.')
})
