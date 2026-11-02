import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { actions } from '../extensions/codemode/server.ts'
import { chapterFiles, FIRST_CHAPTER, requestChapter } from '../lib/chapters.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import { temp } from './helpers.ts'

it('reads closed chapter records exactly like live fork-aware history, with titles and read validation', async () => {
  const home = await temp('ultimate-codemode-chapters-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  await (await prepared.open(false)).close()
  await requestChapter(home, 'next')
  let opened = await prepared.open(false)
  const host = {
    home,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    conversations: () => [],
    uiState: async () => ({}),
  } as unknown as ExtensionHost
  const ctx = { host, signal: new AbortController().signal } as ActionContext
  const read = (op: string, args: JsonValue[]) => actions.read({ op, args }, ctx)
  try {
    const parent = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const first = await parent.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, parent.id), { title: 'Before' })
      return tx.appendEntry(parent.id, {
        kind: 'chapter.note',
        data: { text: 'chapter-needle' },
        model: [{ role: 'user', content: 'chapter-needle', timestamp: 1 }],
      })
    }, context)
    await parent.commit(async (tx) => {
      ;(await tx.doc(Metadata, parent.id)).title = 'After'
    }, context)
    const fork = await parent.fork(first.id, { ownership: { kind: 'ownerless' } }, context)
    await fork.commit(async (tx) => {
      await tx.appendEntry(fork.id, { kind: 'chapter.note', data: { text: 'chapter-needle fork' } })
      await tx.appendEntry(fork.id, { kind: 'pi.reset', head: 'self' })
    }, context)
    await parent.commit(async (tx) => {
      await tx.appendEntry(parent.id, {
        kind: 'chapter.note',
        data: { text: 'excluded after fork' },
      })
    }, context)
    const live = await read('entries', [fork.id])
    const filtered = await read('entries', [fork.id, { kinds: ['chapter.note'], limit: 1 }])
    const before = await read('entries', [
      fork.id,
      { before: (filtered as { id: number }[])[0].id },
    ])
    const search = await read('search', ['chapter-needle'])
    // The live listing as the host builds it: summaries from the harness, and fork concluded in the UI state.
    const records = await opened.harness.commit(
      (tx) => tx.scanConversations({}, 100, undefined),
      context,
    )
    const listing = await Promise.all(
      records.items.map(async (record) => {
        const found = (await opened.harness.conversation(record.id, context))!
        const metadata = await opened.harness.snapshot(Metadata, record.id, context)
        const title = metadata?.title ?? metadata?.inputTitle
        return {
          ...record,
          ...(title !== undefined && { title }),
          ...(metadata?.label !== undefined && { label: metadata.label }),
          cwd: (await found.agent(context)).cwd,
          busy: false,
          ...(record.id === fork.id && { concluded: true }),
        }
      }),
    )
    await opened.harness.commit(async (tx) => {
      ;(await tx.doc(UiState, opened.root.id))['ext.conversations.concluded'] = [fork.id]
    }, context)
    // Naming the active chapter reads the harness too.
    expect(await read('entries', [fork.id, { chapter: 'next' }])).toEqual(live)
    await opened.close()
    await requestChapter(home, FIRST_CHAPTER)
    opened = await prepared.open(false)
    const database = chapterFiles(home, 'next').database
    const bytes = await readFile(database)
    expect(await read('entries', [fork.id, { chapter: 'next' }])).toEqual(live)
    expect(
      await read('entries', [fork.id, { chapter: 'next', kinds: ['chapter.note'], limit: 1 }]),
    ).toEqual(filtered)
    expect(
      await read('entries', [
        fork.id,
        { chapter: 'next', before: (filtered as { id: number }[])[0].id },
      ]),
    ).toEqual(before)
    expect(await read('search', ['chapter-needle', { chapter: 'next' }])).toEqual(search)
    expect(listing).toContainEqual(expect.objectContaining({ id: parent.id, title: 'After' }))
    expect(await read('conversations', [{ chapter: 'next' }])).toEqual(listing)
    expect(await readFile(database)).toEqual(bytes)
    await expect(read('entries', [fork.id])).rejects.toThrow('Unknown conversation')
    await expect(read('entries', [fork.id, { chapter: 'next', limit: 0 }])).rejects.toThrow(
      'limit must be',
    )
    await expect(read('entries', [0, { chapter: 'next' }])).rejects.toThrow(
      'conversationId must be',
    )
    await expect(read('entries', [999999, { chapter: 'next' }])).rejects.toThrow(
      'Unknown conversation',
    )
    await expect(read('search', ['', { chapter: 'next' }])).rejects.toThrow(
      'search text must be nonempty',
    )
    for (const [op, args] of [
      ['conversations', [{ chapter: 'missing' }]],
      ['entries', [fork.id, { chapter: 'missing' }]],
      ['search', ['needle', { chapter: 'missing' }]],
    ] as [string, JsonValue[]][]) {
      await expect(read(op, args)).rejects.toThrow(
        'Unknown chapter missing. Chapters: the-beginning, next',
      )
    }
    await expect(
      read('conversations', [{ chapter: 'next', project: 'elsewhere' }]),
    ).rejects.toThrow('chapter and project cannot be used together')
  } finally {
    await opened.close()
  }
})
