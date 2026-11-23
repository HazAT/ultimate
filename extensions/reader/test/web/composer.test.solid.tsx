import { createSignal, flush, Show } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Composer } from '../../comment.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async () => Response.json({ result: null })
  const clientStore = createStore({ fetch })
  const api = createApi(clientStore, { fetch })
  return {
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    reportCompact: () => {},
    store: clientStore,
    uiState: createUiState(undefined),
  }
})

it('closes the composer after Add when the browser returns a Promise from focus and scrollIntoView', ({
  onTestFinished,
}) => {
  const returnsPromise = () => Promise.resolve()
  const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(returnsPromise)
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(returnsPromise)
  onTestFinished(() => {
    focus.mockRestore()
    scroll.mockRestore()
  })
  const [open, setOpen] = createSignal(true)
  const added = vi.fn<(text: string) => void>(() => setOpen(false))
  const view = renderSolid(() => (
    <Show when={open()}>
      <Composer
        excerpt="Some text."
        lines={{ start: 3, end: 3 }}
        onCancel={() => setOpen(false)}
        onSubmit={added}
        onText={() => {}}
        submit="Add comment"
        text="Say why"
      />
    </Show>
  ))
  expect(scroll).toHaveBeenCalled()
  view.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  flush()
  expect(added).toHaveBeenCalledWith('Say why')
  expect(view.querySelector('[data-reader-composer]')).toBeNull()
})
