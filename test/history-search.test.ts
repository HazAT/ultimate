import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord'
import { expect, it } from 'vitest'
import { HistoryApi } from '../extensions/codemode/api.ts'
import type { HistoryHit, HistoryService } from '../extensions/codemode/api.ts'
import { actions as codemode } from '../extensions/codemode/server.ts'
import { highlight } from '../extensions/history-search/highlight.ts'
import { actions } from '../extensions/history-search/server.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

it('highlights each match of the query in an excerpt', () => {
  expect(highlight('a "needle" and a needle', 'needle')).toEqual([
    { text: 'a "', hit: false },
    { text: 'needle', hit: true },
    { text: '" and a ', hit: false },
    { text: 'needle', hit: true },
  ])
  expect(highlight('aaa', 'aa')).toEqual([
    { text: 'aa', hit: true },
    { text: 'a', hit: false },
  ])
  expect(highlight('nothing here', 'absent')).toEqual([{ text: 'nothing here', hit: false }])
  expect(highlight('regex (x) $^.*', '(')).toEqual([
    { text: 'regex ', hit: false },
    { text: '(', hit: true },
    { text: 'x) $^.*', hit: false },
  ])
  expect(highlight('whole match', 'whole match')).toEqual([{ text: 'whole match', hit: true }])
  expect(highlight('excerpt', '')).toEqual([{ text: 'excerpt', hit: false }])
  expect(highlight('', 'needle')).toEqual([{ text: '', hit: false }])
})

it('searches through codemode, scoped to a conversation, the project, or every project', async () => {
  const home = await temp('ultimate-history-search-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const opened = await prepared.open(false)
  try {
    const parent = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    await parent.commit(
      async (tx) =>
        tx.appendEntry(parent.id, {
          kind: 'chapter.note',
          data: { text: 'needle-alpha' },
          model: [{ role: 'user', content: 'needle-alpha', timestamp: 1 }],
        }),
      context,
    )
    const second = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    await second.commit(
      async (tx) =>
        tx.appendEntry(second.id, { kind: 'chapter.note', data: { text: 'needle-beta' } }),
      context,
    )

    // The service as codemode provides it: `search` is the real read action, `searchProject` a stub standing for
    // another instance.
    const codemodeHost = {
      home,
      get chapter() {
        return prepared.chapter
      },
      harness: () => opened.harness,
      conversations: () => [],
      uiState: async () => ({}),
    } as unknown as ExtensionHost
    const read = async (op: string, args: JsonValue[]) =>
      codemode.read({ op, args }, {
        host: codemodeHost,
        signal: new AbortController().signal,
      } as ActionContext) as Promise<HistoryHit[]>
    const asked: string[] = []
    const service: HistoryService = {
      search: async (text, options = {}) => await read('search', [text, options]),
      searchProject: async (project, text) => {
        asked.push(project)
        if (project === 'away') throw new Error('away is not running')
        return project === 'other'
          ? {
              url: 'https://other.test',
              hits: [{ conversation: 7, id: 3, kind: 'pi.user', excerpt: `other ${text}` }],
            }
          : undefined
      },
    }
    const host = {
      want: (api: unknown) => (api === HistoryApi ? service : undefined),
      projects: async () => [
        { name: 'here', current: true },
        { name: 'other', current: false, running: { pid: 1, url: 'https://other.test' } },
        { name: 'away', current: false, running: { pid: 2, url: 'https://away.test' } },
        { name: 'shut', current: false },
      ],
    } as unknown as ExtensionHost
    const ctx = (conversationId?: number) =>
      ({
        host,
        signal: new AbortController().signal,
        ...(conversationId !== undefined && { conversationId }),
      }) as ActionContext

    // The whole project: both conversations answer, and no other project is asked.
    const project = await actions.search({ text: 'needle' }, ctx())
    expect(project.hits.map((hit) => hit.excerpt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('needle-alpha'),
        expect.stringContaining('needle-beta'),
      ]),
    )
    expect(project.hits).toHaveLength(2)
    expect(asked).toEqual([])

    // One conversation: only its own stored history answers.
    const one = await actions.search({ text: 'needle', scope: 'conversation' }, ctx(parent.id))
    expect(one.hits.map((hit) => hit.excerpt)).toEqual([expect.stringContaining('needle-alpha')])

    // Every project: the other one is asked once, its hits named and linked; a project that does not run is never
    // asked, and one that fails does not hide the rest.
    const all = await actions.search({ text: 'needle', scope: 'all' }, ctx())
    expect(all.hits.map((hit) => hit.excerpt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('needle-alpha'),
        expect.stringContaining('other needle'),
      ]),
    )
    const remote = all.hits.find((hit) => hit.project !== undefined)
    expect(remote).toMatchObject({ project: 'other', url: 'https://other.test' })
    expect(asked).toEqual(['other', 'away'])
    expect(all.errors).toEqual([{ project: 'away', message: 'away is not running' }])

    // A limit bounds the answer.
    const limited = await actions.search({ text: 'needle', limit: 1 }, ctx())
    expect(limited.hits).toHaveLength(1)

    // Bad calls say what is wrong.
    await expect(actions.search({ text: '  ' }, ctx())).rejects.toThrow('text must be nonempty')
    await expect(actions.search({ text: 'needle', scope: 'tree' }, ctx())).rejects.toThrow(
      'scope must be one of conversation, project, all',
    )
    await expect(actions.search({ text: 'needle', limit: 0 }, ctx())).rejects.toThrow(
      'limit must be an integer from 1 to 1000',
    )
    await expect(actions.search({ text: 'needle', scope: 'conversation' }, ctx())).rejects.toThrow(
      'No conversation is shown',
    )
    await expect(
      actions.search({ text: 'needle' }, {
        host: { want: () => undefined } as unknown as ExtensionHost,
        signal: new AbortController().signal,
      } as ActionContext),
    ).rejects.toThrow('history search needs codemode, which is disabled')
  } finally {
    await opened.close()
  }
})
