import { describe, expect, it, vi } from 'vitest'
import {
  dropInto,
  plainDrop,
  tookDrop,
  tookPaste,
  watchDrops,
} from '../../web/src/app/input-handlers.ts'
import type { HandlerFailure, InputHandlers } from '../../web/src/app/input-handlers.ts'
import type { ComposerDrop, ComposerInput, ComposerPaste } from '../../web/src/sdk/types.ts'

function fakeComposer() {
  return {
    conversationId: 7,
    insert: vi.fn<(text: string) => void>(),
    addImages: vi.fn<(files: readonly File[]) => Promise<void>>(async () => undefined),
    setError: vi.fn<(message: string | undefined) => void>(),
    show: vi.fn<(ui?: unknown) => void>(),
  } satisfies ComposerInput
}

/** The payload of a drag, as the browser hands one over. */
function drag(files: readonly Partial<File>[], text: string, shiftKey = false): ComposerDrop {
  return {
    dataTransfer: {
      files,
      getData: (format: string) => (format === 'text/plain' ? text : ''),
    } as unknown as DataTransfer,
    shiftKey,
  }
}

const paste = (text: string): ComposerPaste => ({ text, files: [] })

// The guard asks whether a drag landed in a field, which needs a DOM this test has none of.
vi.stubGlobal(
  'Element',
  class Element {
    closest() {
      return null
    }
  },
)

describe('composer input handlers', () => {
  it('gives an event to the first handler in order that claims it, and stops there', () => {
    const composer = fakeComposer()
    const third = vi.fn<(drop: ComposerDrop, own: ComposerInput) => boolean>(() => true)
    const handlers: InputHandlers = [
      { extension: 'quiet', version: 1, drop: () => false },
      { extension: 'claims', version: 1, drop: () => true },
      { extension: 'never', version: 1, drop: third },
    ]
    expect(tookDrop(handlers, drag([], 'notes'), () => composer, vi.fn())).toBe(true)
    expect(third).not.toHaveBeenCalled()
    // Nothing claims it, so the composer's own handling of the drop runs.
    expect(
      tookDrop(
        [{ extension: 'quiet', version: 1, drop: () => false }],
        drag([], 'notes'),
        () => composer,
        vi.fn(),
      ),
    ).toBe(false)
  })

  it('leaves a drop to its handler when one claims it, and to the composer when none does', () => {
    const image = { name: 'shot.png', type: 'image/png' }
    const claimed = fakeComposer()
    const own = (drop: ComposerDrop, composer: ComposerInput) => {
      composer.insert('/Users/x/a.txt')
      return true
    }
    dropInto(
      [{ extension: 'takes', version: 1, drop: own }],
      drag([image], 'a note'),
      () => claimed,
      vi.fn(),
    )
    expect(claimed.insert).toHaveBeenCalledWith('/Users/x/a.txt')
    expect(claimed.insert).toHaveBeenCalledTimes(1)
    expect(claimed.addImages).not.toHaveBeenCalled()

    const unclaimed = fakeComposer()
    dropInto(
      [{ extension: 'quiet', version: 1, drop: () => false }],
      drag([image], 'a note'),
      () => unclaimed,
      vi.fn(),
    )
    expect(unclaimed.addImages).toHaveBeenCalledWith([image])
    expect(unclaimed.insert).toHaveBeenCalledWith('a note')
    // A file with no text and no image is nothing the plain composer can place.
    const filesOnly = fakeComposer()
    plainDrop(drag([{ name: 'report.pdf', type: 'application/pdf' }], ''), filesOnly)
    expect(filesOnly.insert).not.toHaveBeenCalled()
    expect(filesOnly.addImages).not.toHaveBeenCalled()
  })

  it('reports a handler that throws and lets the next one have the event', () => {
    const report = vi.fn<HandlerFailure>()
    const handlers: InputHandlers = [
      {
        extension: 'broken',
        version: 1,
        paste: () => {
          throw new Error('half a paste')
        },
      },
      { extension: 'claims', version: 1, paste: () => true },
    ]
    expect(tookPaste(handlers, paste('a block'), () => fakeComposer(), report)).toBe(true)
    expect(report).toHaveBeenCalledWith('broken', 'paste', expect.any(Error))
  })

  it('keeps a dropped file from navigating the page, with no composer and no handler', () => {
    const listeners = new Map<string, (event: DragEvent) => void>()
    const shell = {
      addEventListener: (name: string, listener: (event: DragEvent) => void) => {
        listeners.set(name, listener)
      },
    } as unknown as Document
    const land = vi.fn<(event: DragEvent) => void>()
    watchDrops(shell, land)
    const preventDefault = vi.fn<() => void>()
    const event = {
      dataTransfer: { types: ['Files'], files: [], getData: () => '' },
      target: null,
      shiftKey: false,
      preventDefault,
    } as unknown as DragEvent
    for (const name of ['dragenter', 'dragover']) listeners.get(name)!(event)
    expect(preventDefault).toHaveBeenCalledTimes(2)
    listeners.get('drop')!(event)
    expect(preventDefault).toHaveBeenCalledTimes(3)
    expect(land).toHaveBeenCalledWith(event)
  })
})
