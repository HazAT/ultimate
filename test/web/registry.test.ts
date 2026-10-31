import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import {
  commandApplies,
  commandItems,
  createRegistry,
  documentItems,
  extensionName,
  panelItems,
  entryRenderers,
  resolveSurface,
  shownPanels,
  slotItems,
  surfaceItems,
  toolRenderers,
  linkRenderers,
  codeBlockLanguages,
  codeBlockRenderers,
  messageItems,
  composerRenderers,
  composerInputs,
  compactDocs,
  compactTools,
} from '../../web/src/sdk/registry.ts'
import type { ExtensionLoader, PanelItem, SurfaceItem } from '../../web/src/sdk/registry.ts'
import { attention } from '../../web/src/sdk/types.ts'
import type { WebExtension } from '../../web/src/sdk/types.ts'

const path = (name: string) => `../../extensions/${name}/web.tsx`
/** The shown panel's id and the tab row's ids. */
const ids = ({ active, tabs }: ReturnType<typeof shownPanels>) => [
  active?.id,
  tabs.map((item) => item.id),
]
const component = (label: string) => Object.assign(() => null, { displayName: label })
const module = (extension: WebExtension) => ({ default: extension })
/** A compact row of an entry of `kind`. */
const row = (kind: string) => ({ entry: { kind } as EntryRecord, calls: [] })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('web extension registry', () => {
  it('loads each facet lazily and on its own, isolating a broken one', async () => {
    expect(extensionName('/@fs/repo/extensions/status-line/web.tsx?t=1')).toBe('status-line')
    expect(extensionName(path('hello'))).toBe('hello')
    expect(extensionName('/repo/web/src/main.tsx')).toBeUndefined()
    const slow = deferred<unknown>()
    const Late = component('late')
    const Early = component('early')
    const loaders: Record<string, ExtensionLoader> = {
      [path('beta')]: vi.fn<ExtensionLoader>(() => slow.promise),
      [path('alpha')]: vi.fn<ExtensionLoader>(async () =>
        module({
          slots: { 'statusline.left': [Early] },
          commands: [{ id: 'a', title: 'A', run() {} }],
        }),
      ),
      [path('broken')]: vi.fn<ExtensionLoader>(async () => {
        throw new SyntaxError('Unexpected token (3:14)')
      }),
    }
    const registry = createRegistry()
    for (const loader of Object.values(loaders)) expect(loader).not.toHaveBeenCalled()

    const settled = registry.setLoaders(loaders)
    expect(registry.getSnapshot().map((record) => [record.name, record.loading])).toEqual([
      ['beta', true],
      ['alpha', true],
      ['broken', true],
    ])
    await vi.waitFor(() => {
      expect(
        registry.getSnapshot().find((record) => record.name === 'alpha')?.extension,
      ).toBeDefined()
    })
    // alpha and broken settled while beta is still loading.
    const early = registry.getSnapshot()
    expect(early.find((record) => record.name === 'beta')?.loading).toBe(true)
    expect(early.find((record) => record.name === 'broken')?.error).toBe('Unexpected token (3:14)')
    expect(slotItems(early, 'statusline.left').map((item) => item.component)).toEqual([Early])

    slow.resolve(module({ slots: { 'statusline.left': { component: Late, order: -1 } } }))
    await settled
    const records = registry.getSnapshot()
    expect(records.map((record) => [record.name, !!record.extension, record.error])).toEqual([
      ['beta', true, undefined],
      ['alpha', true, undefined],
      ['broken', false, 'Unexpected token (3:14)'],
    ])
    // `order` first, then discovery order.
    expect(slotItems(records, 'statusline.left').map((item) => item.extension)).toEqual([
      'beta',
      'alpha',
    ])
    expect(commandItems(records).map((command) => `${command.extension}:${command.id}`)).toEqual([
      'alpha:a',
    ])
    for (const loader of Object.values(loaders)) expect(loader).toHaveBeenCalledOnce()
  })

  it('keeps the previous version of a facet whose reload fails, and recovers', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    const listener = vi.fn<() => void>()
    registry.subscribe(listener)
    const extension: WebExtension = { slots: { overlay: First } }
    await registry.setLoaders({ [path('hello')]: async () => module(extension) })
    const installed = registry.getSnapshot()[0]
    expect(installed.version).toBe(1)
    await registry.setLoaders({ [path('hello')]: async () => module(extension) })
    expect(registry.getSnapshot()[0]).toBe(installed)

    registry.fail('hello', new Error('Transform failed'))
    const failed = registry.getSnapshot()[0]
    expect(failed.error).toBe('Transform failed')
    expect(slotItems(registry.getSnapshot(), 'overlay').map((item) => item.component)).toEqual([
      First,
    ])

    registry.replace('hello', module({ slots: { overlay: Second } }))
    const recovered = registry.getSnapshot()[0]
    expect(recovered.error).toBeUndefined()
    expect(recovered.version).toBe(2)
    expect(slotItems(registry.getSnapshot(), 'overlay').map((item) => item.component)).toEqual([
      Second,
    ])
    expect(listener).toHaveBeenCalled()
  })

  it('rejects a facet without a default export and drops removed folders', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('empty')]: async () => ({}),
      [path('kept')]: async () => module({}),
    })
    expect(registry.getSnapshot().find((record) => record.name === 'empty')?.error).toMatch(
      /default-export defineWebExtension/,
    )
    await registry.setLoaders({ [path('kept')]: async () => module({}) })
    expect(registry.getSnapshot().map((record) => record.name)).toEqual(['kept'])
  })

  it('rejects malformed contributions at install, keeping the last good version', async () => {
    const Good = component('good')
    const good: WebExtension = {
      slots: { overlay: Good, sidebar: [{ component: Good, order: -1 }] },
      panels: [{ id: 'hello', title: 'Hello', component: Good }],
      surfaces: [{ id: 'hello', title: 'Hello', icon: Good, component: Good }],
      tools: { hello: Object.assign(Object.create(null), { $$typeof: Symbol.for('react.memo') }) },
      entries: { 'hello.entry': Good },
      documents: [{ kind: 'hello.doc', title: 'Hello', icon: Good, component: Good }],
      commands: [{ id: 'hello.run', title: 'Run', keys: 'escape', whileTyping: true, run() {} }],
    }
    const registry = createRegistry()
    await registry.setLoaders({ [path('hello')]: async () => module(good) })
    const [installed] = registry.getSnapshot()
    expect(installed.extension).toBe(good)
    expect(installed.error).toBeUndefined()

    const malformed: [unknown, RegExp][] = [
      [{ surfaces: {} }, /^surfaces must be an array of \{ id, title, icon,/],
      [{ panels: {} }, /^panels must be an array/],
      [{ surfaces: [{ id: 'x', title: 'X', component: Good }] }, /^surfaces must/],
      [
        { commands: [{ id: 'x', title: 'X' }] },
        /^commands must be an array of \{ id, title, keys\?/,
      ],
      [{ commands: [{ id: 'x', title: 'X', keys: ['escape'], run() {} }] }, /^commands must/],
      [{ slots: [Good] }, /^slots must be an object/],
      [{ slots: { overlay: { order: 1 } } }, /^slots must/],
      [{ tools: { bash: 'Bash' } }, /^tools must be an object/],
      [{ entries: [Good] }, /^entries must be an object/],
      [{ link: [Good] }, /^link must be a link renderer component/],
      [{ documents: {} }, /^documents must be an array of \{ kind, title, icon\?, component \}/],
      [{ documents: [{ kind: 'x', title: 'X' }] }, /^documents must/],
      [{ documents: [{ kind: 1, title: 'X', component: Good }] }, /^documents must/],
    ]
    for (const [extension, error] of malformed) {
      registry.replace('hello', { default: extension })
      const records = registry.getSnapshot()
      expect(records[0].error).toMatch(error)
      expect(records[0].extension).toBe(good)
      expect(surfaceItems(records).map((surface) => surface.id)).toEqual(['hello'])
      expect(panelItems(records).map((panel) => panel.id)).toEqual(['hello'])
      expect(commandItems(records).map((command) => command.id)).toEqual(['hello.run'])
      expect(slotItems(records, 'sidebar')).toHaveLength(1)
      expect([...documentItems(records).keys()]).toEqual(['hello.doc'])
    }

    // A malformed first load installs nothing, and the shell's selectors still work.
    const fresh = createRegistry()
    await fresh.setLoaders({
      [path('broken')]: async () => ({ default: { surfaces: {}, panels: {} } }),
    })
    const records = fresh.getSnapshot()
    expect(records[0].extension).toBeUndefined()
    expect(records[0].error).toMatch(/^panels must/)
    expect(surfaceItems(records)).toEqual([])
    expect(panelItems(records)).toEqual([])
  })

  it('resolves command ids like surface ids: a later facet wins, in the place of the first', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('agent')]: async () =>
        module({
          commands: [
            { id: 'agent.compact', title: 'Compact', run() {} },
            { id: 'agent.stop', title: 'Stop', run() {} },
          ],
        }),
      [path('mine')]: async () =>
        module({
          commands: [
            { id: 'agent.compact', title: 'Compact mine', run() {} },
            { id: 'ultimate.panel', title: 'My panel', run() {} },
            { id: 'mine.own', title: 'Own', run() {} },
          ],
        }),
    })
    const base = [
      { id: 'ultimate.palette', title: 'Command palette', extension: 'core', run() {} },
      { id: 'ultimate.panel', title: 'Toggle the right panel', extension: 'core', run() {} },
    ]
    expect(
      commandItems(registry.getSnapshot(), base).map(
        (command) => `${command.extension}:${command.id}:${command.title}`,
      ),
    ).toEqual([
      'core:ultimate.palette:Command palette',
      'mine:ultimate.panel:My panel',
      'mine:agent.compact:Compact mine',
      'agent:agent.stop:Stop',
      'mine:mine.own:Own',
    ])
  })

  it('resolves renderers and panels across facets', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({
          tools: { bash: First },
          link: First,
          codeBlocks: { mermaid: First },
          entries: { 'pi.user': First },
          panels: [{ id: 'info', title: 'Info', component: First, order: 2 }],
          documents: [
            { kind: 'ultimate.plan', title: 'Plan', component: First },
            { kind: 'a.notes', title: 'Notes', component: First },
          ],
        }),
      [path('b')]: async () =>
        module({
          tools: { bash: Second },
          link: Second,
          codeBlocks: { mermaid: Second, dot: Second },
          entries: { 'pi.compaction': Second, 'pi.user': Second },
          panels: [{ id: 'tasks', title: 'Tasks', component: Second, order: 1 }],
          documents: [{ kind: 'ultimate.plan', title: 'My plan', component: Second }],
        }),
    })
    const records = registry.getSnapshot()
    expect(toolRenderers(records, 'bash')).toEqual([
      { extension: 'a', version: 1, component: First },
      { extension: 'b', version: 1, component: Second },
    ])
    expect(toolRenderers(records, 'read')).toEqual([])
    // Link renderers compose like tool renderers, each wrapping the one before it.
    expect(linkRenderers(records)).toEqual([
      { extension: 'a', version: 1, component: First },
      { extension: 'b', version: 1, component: Second },
    ])
    expect(codeBlockRenderers(records, 'mermaid')).toEqual([
      { extension: 'a', version: 1, component: First },
      { extension: 'b', version: 1, component: Second },
    ])
    expect(codeBlockLanguages(records)).toEqual(['mermaid', 'dot'])
    // Entry renderers compose instead of replacing each other: all of them, in folder order.
    expect(entryRenderers(records, 'pi.user').map((renderer) => renderer.extension)).toEqual([
      'a',
      'b',
    ])
    expect(entryRenderers(records, 'pi.compaction').map((renderer) => renderer.component)).toEqual([
      Second,
    ])
    expect(entryRenderers(records, 'pi.system')).toEqual([])
    expect(panelItems(records).map((panel) => panel.id)).toEqual(['tasks', 'info'])
    const documents = documentItems(records)
    expect(documents.get('ultimate.plan')).toMatchObject({ extension: 'b', title: 'My plan' })
    expect(documents.get('ultimate.plan')?.component).toBe(Second)
    expect(documents.get('a.notes')?.extension).toBe('a')
    expect(documents.has('codemode.store')).toBe(false)
  })

  it('lists composer input handlers with a later facet’s first, then each facet’s own order', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('alpha')]: async () =>
        module({
          composerInput: [{ drop: () => false }, {}, { paste: () => true }],
        }),
      [path('beta')]: async () => module({ composerInput: [{ drop: () => false }] }),
    })
    const handlers = composerInputs(registry.getSnapshot())
    expect(
      handlers.map((handler) => [handler.extension, ...Object.keys(handler).slice(2)]),
    ).toEqual([['beta', 'drop'], ['alpha', 'drop'], ['alpha'], ['alpha', 'paste']])
  })

  it('composes all composer renderers in discovery order', async () => {
    const First = component('alpha')
    const Second = component('beta')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('alpha')]: async () => module({ composer: First }),
      [path('beta')]: async () => module({ composer: Second }),
    })
    const renderers = composerRenderers(registry.getSnapshot())
    expect(renderers.map((r) => r.extension)).toEqual(['alpha', 'beta'])
    expect(renderers.map((r) => r.component)).toEqual([First, Second])
    expect(renderers.reduce((core, r) => `${r.extension}(${core})`, 'core')).toBe(
      'beta(alpha(core))',
    )
  })

  it('lists answer labels independently in discovery order and rejects malformed labels', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () => module({ answerLabels: [First, Second] }),
      [path('b')]: async () => module({ answerLabels: [Second] }),
    })
    expect(messageItems(registry.getSnapshot(), 'answerLabels')).toEqual([
      { key: 'a:0', extension: 'a', version: 1, component: First },
      { key: 'a:1', extension: 'a', version: 1, component: Second },
      { key: 'b:0', extension: 'b', version: 1, component: Second },
    ])
    expect(messageItems(registry.getSnapshot(), 'messageDetails')).toEqual([])
    for (const answerLabels of [First, [42]]) {
      registry.replace('b', { default: { answerLabels } })
      expect(registry.getSnapshot()[1]?.error).toBe(
        'answerLabels must be an array of answer label components',
      )
      expect(messageItems(registry.getSnapshot(), 'answerLabels')).toHaveLength(3)
    }
  })

  it('makes a conversation compact when a facet says so, combining their visible tools', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({ compact: { when: (c) => c.label === 'agent', tools: ['message', 'branch'] } }),
      [path('b')]: async () =>
        module({ compact: { when: (c) => c.id === 7, tools: ['workspace'] } }),
      [path('b2')]: async () =>
        module({
          compact: {
            when: (c, docs) => (docs.index as { main?: number } | undefined)?.main === c.id,
            tools: ['setup'],
            docs: ['index'],
          },
        }),
      [path('c')]: async () =>
        module({
          compact: {
            when: () => {
              throw new Error('broken')
            },
          },
        }),
    })
    const report = vi.fn<(extension: string, error: unknown) => void>()
    const records = registry.getSnapshot()
    const kept = (conversation: { id: number; label?: string }, docs = {}) => {
      const { keeps } = compactTools(records, { ...conversation, busy: false }, docs, report)!
      return ['message', 'branch', 'workspace', 'setup', 'bash'].filter((name) =>
        keeps({ type: 'toolCall', id: name, name, arguments: {} }, {}),
      )
    }
    expect(kept({ id: 7, label: 'agent' })).toEqual(['message', 'branch', 'workspace'])
    expect(kept({ id: 3, label: 'agent' })).toEqual(['message', 'branch'])
    // `when` reads the root documents passed in.
    expect(kept({ id: 4 }, { index: { main: 4 } })).toEqual(['setup'])
    expect(compactTools(records, { id: 4, busy: false }, { index: { main: 5 } }, report)).toBe(
      undefined,
    )
    expect(compactTools(records, { id: 3, busy: false }, {}, report)).toBeUndefined()
    expect(compactTools(records, undefined, {}, report)).toBeUndefined()
    expect(report).toHaveBeenCalledWith('c', new Error('broken'))
    const shape = 'compact must be a { when, tools?, docs?, quiet?, summary?, thread? } object'
    registry.replace('b', { default: { compact: { tools: ['workspace'] } } })
    expect(registry.getSnapshot()[1]?.error).toBe(shape)
    registry.replace('b', { default: { compact: { when: () => true, docs: [1] } } })
    expect(registry.getSnapshot()[1]?.error).toBe(shape)
    registry.replace('b', { default: { compact: { when: () => true, quiet: true } } })
    expect(registry.getSnapshot()[1]?.error).toBe(shape)
  })

  it('calls a row quiet when any facet does, hidden only when none shows it, and a throwing test no', async () => {
    const Summary = component('summary')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({
          compact: { when: () => true, quiet: ({ entry }) => entry.kind === 'note' || 'hidden' },
        }),
      [path('b')]: async () =>
        module({
          compact: {
            when: () => true,
            quiet: ({ entry }) => {
              if (entry.kind === 'boom') throw new Error('broken')
              return entry.kind === 'reply'
            },
            summary: Summary,
          },
        }),
    })
    const report = vi.fn<(extension: string, error: unknown) => void>()
    const { quiet, summary } = compactTools(
      registry.getSnapshot(),
      { id: 1, busy: false },
      {},
      report,
    )!
    expect(quiet(row('note'), {})).toBe(true)
    expect(quiet(row('reply'), {})).toBe(true)
    expect(quiet(row('user'), {})).toBe('hidden')
    expect(quiet(row('boom'), {})).toBe('hidden')
    expect(report).toHaveBeenCalledWith('b', new Error('broken'))
    expect(summary).toMatchObject({ extension: 'b', component: Summary })
  })

  it('never folds a row an attention renderer draws: not background, thread, and its calls kept', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({
          compact: { when: () => true, quiet: () => true, thread: () => false },
        }),
      [path('b')]: async () =>
        module({
          entries: { 'dream.prepared': attention(component('card')), other: component('other') },
          tools: { setup: attention(component('setup')) },
        }),
    })
    const { quiet, thread, keeps } = compactTools(
      registry.getSnapshot(),
      { id: 1, busy: false },
      {},
      vi.fn(),
    )!
    const setup = { type: 'toolCall' as const, id: 's', name: 'setup', arguments: {} }
    expect(quiet(row('dream.prepared'), {})).toBe(false)
    expect(thread!(row('dream.prepared'), {})).toBe(true)
    expect(quiet(row('other'), {})).toBe(true)
    expect(thread!(row('other'), {})).toBe(false)
    expect(keeps(setup, {})).toBe(true)
    expect(thread!({ entry: { kind: 'pi.assistant' } as EntryRecord, calls: [setup] }, {})).toBe(
      true,
    )
  })

  it('keeps a call its test keeps from the root documents, and counts a throwing test as no', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('a')]: async () =>
        module({
          compact: {
            when: () => true,
            tools: [
              'message',
              (call, docs) =>
                call.name === 'codemode' &&
                !!(docs.log as { calls?: string[] } | undefined)?.calls?.includes(call.id),
            ],
            docs: ['log'],
          },
        }),
      [path('b')]: async () =>
        module({
          compact: {
            when: () => true,
            tools: [
              () => {
                throw new Error('broken')
              },
            ],
            docs: ['log', 'board'],
          },
        }),
    })
    const report = vi.fn<(extension: string, error: unknown) => void>()
    const records = registry.getSnapshot()
    expect(compactDocs(records)).toEqual(['board', 'log'])
    const { keeps } = compactTools(records, { id: 1, busy: false }, {}, report)!
    const script = { type: 'toolCall' as const, id: 's', name: 'codemode', arguments: {} }
    expect(keeps(script, {})).toBe(false)
    expect(keeps(script, { log: { calls: ['t'] } })).toBe(false)
    expect(keeps(script, { log: { calls: ['s'] } })).toBe(true)
    expect(keeps({ ...script, name: 'message' }, {})).toBe(true)
    expect(report).toHaveBeenCalledWith('b', new Error('broken'))
  })

  it('lists message actions in discovery and contribution order, validating their shape', async () => {
    const First = component('first')
    const Second = component('second')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('builtin-z')]: async () => module({ messageActions: [First, Second] }),
      [path('project-a')]: async () => module({ messageActions: [Second] }),
    })
    expect(messageItems(registry.getSnapshot(), 'messageActions')).toEqual([
      { key: 'builtin-z:0', extension: 'builtin-z', version: 1, component: First },
      { key: 'builtin-z:1', extension: 'builtin-z', version: 1, component: Second },
      { key: 'project-a:0', extension: 'project-a', version: 1, component: Second },
    ])
    registry.replace('project-a', { default: { messageActions: [42] } })
    expect(registry.getSnapshot()[1]?.error).toBe(
      'messageActions must be an array of message action components',
    )
    expect(messageItems(registry.getSnapshot(), 'messageActions')).toHaveLength(3)
  })

  it('lists message details apart from message actions, validating their shape', async () => {
    const Detail = component('detail')
    const registry = createRegistry()
    await registry.setLoaders({
      [path('builtin-z')]: async () => module({ messageDetails: [Detail] }),
    })
    expect(messageItems(registry.getSnapshot(), 'messageDetails')).toEqual([
      { key: 'builtin-z:0', extension: 'builtin-z', version: 1, component: Detail },
    ])
    expect(messageItems(registry.getSnapshot(), 'messageActions')).toEqual([])
    registry.replace('builtin-z', { default: { messageDetails: {} } })
    expect(registry.getSnapshot()[0]?.error).toBe(
      'messageDetails must be an array of message detail components',
    )
  })

  it('lists surfaces with Agent first, then by order and title, a later facet winning an id', async () => {
    const icon = component('icon')
    const surface = (id: string, title: string, order?: number) => ({
      id,
      title,
      icon,
      order,
      component: component(id),
    })
    const registry = createRegistry()
    await registry.setLoaders({
      [path('agent')]: async () => module({ surfaces: [surface('agent', 'Agent', 50)] }),
      [path('apps')]: async () =>
        module({
          surfaces: [
            surface('apps.zebra', 'Zebra'),
            surface('apps.alpha', 'Alpha'),
            surface('apps.first', 'Way first', -1),
            surface('shared', 'Shared by apps'),
          ],
        }),
      [path('broken')]: async () => {
        throw new SyntaxError('Unexpected token')
      },
      [path('later')]: async () => module({ surfaces: [surface('shared', 'Shared by later')] }),
    })
    const items = surfaceItems(registry.getSnapshot())
    expect(items.map((item) => `${item.extension}:${item.id}`)).toEqual([
      'agent:agent',
      'apps:apps.first',
      'apps:apps.alpha',
      'later:shared',
      'apps:apps.zebra',
    ])
    expect(items.find((item) => item.id === 'shared')?.title).toBe('Shared by later')
  })

  it('shows the chosen surface, the project default, or Agent, and names a missing choice', () => {
    const item = (id: string): SurfaceItem => ({
      id,
      title: id,
      icon: component('icon'),
      component: component(id),
      extension: id,
      version: 1,
    })
    const surfaces = [item('agent'), item('triage')]
    const shown = (options: Parameters<typeof resolveSurface>[1]) => {
      const { surface, ...rest } = resolveSurface(surfaces, options)
      return { surface: surface?.id, ...rest }
    }
    expect(shown({ loading: false })).toEqual({ surface: 'agent', pending: false })
    expect(shown({ chosen: 'triage', loading: false })).toEqual({
      surface: 'triage',
      pending: false,
    })
    // An explicit choice beats the project default, which applies only until the user picks.
    expect(shown({ chosen: 'agent', preferred: 'triage', loading: false }).surface).toBe('agent')
    expect(shown({ preferred: 'triage', loading: false }).surface).toBe('triage')
    // A default naming no installed surface falls back quietly; a missing choice is reported.
    expect(shown({ preferred: 'gone', loading: false })).toEqual({
      surface: 'agent',
      pending: false,
    })
    expect(shown({ chosen: 'gone', loading: false })).toEqual({
      surface: 'agent',
      pending: false,
      missing: 'gone',
    })
    // While facets load, a surface that is not there yet may still arrive.
    expect(shown({ chosen: 'gone', loading: true })).toEqual({ surface: undefined, pending: true })
    expect(shown({ preferred: 'gone', loading: true })).toEqual({
      surface: undefined,
      pending: true,
    })
    expect(shown({ chosen: 'triage', loading: true }).surface).toBe('triage')
    // Without even Agent, nothing resolves and the host shows its bare frame.
    expect(resolveSurface([item('triage')], { chosen: 'gone', loading: false })).toEqual({
      surface: undefined,
      pending: false,
      missing: 'gone',
    })
  })

  it('hides a command whose when() throws and reports it instead of throwing', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('broken')]: async () =>
        module({
          commands: [
            {
              id: 'broken.cmd',
              title: 'Broken',
              when: () => {
                throw new Error('predicate failed')
              },
              run: () => undefined,
            },
            { id: 'broken.ok', title: 'Fine', when: () => true, run: () => undefined },
          ],
        }),
    })
    const report = vi.fn<(command: { id: string; extension: string }, error: unknown) => void>()
    const context = { conversationId: 1 } as Parameters<typeof commandApplies>[1]
    const shown = commandItems(registry.getSnapshot()).filter((command) =>
      commandApplies(command, context, report),
    )
    expect(shown.map((command) => command.id)).toEqual(['broken.ok'])
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatchObject({ id: 'broken.cmd', extension: 'broken' })
    expect(String(report.mock.calls[0][1])).toContain('predicate failed')
  })

  it('keeps a tabless panel out of the tab row until it is shown, and never shows it by default', () => {
    const panel = (id: string, tab?: boolean): PanelItem => ({
      id,
      title: id,
      component: component(id),
      extension: id,
      version: 1,
      ...(tab === undefined ? {} : { tab }),
    })
    const panels = [panel('secrets', false), panel('todos'), panel('info', true)]
    expect(ids(shownPanels(panels, null))).toEqual(['todos', ['todos', 'info']])
    expect(ids(shownPanels(panels, 'gone'))).toEqual(['todos', ['todos', 'info']])
    expect(ids(shownPanels(panels, 'info'))).toEqual(['info', ['todos', 'info']])
    expect(ids(shownPanels(panels, 'secrets'))).toEqual(['secrets', ['secrets', 'todos', 'info']])
    // Only tabless panels: none shows until one is opened.
    expect(ids(shownPanels([panels[0]], null))).toEqual([undefined, []])
    expect(ids(shownPanels([panels[0]], 'secrets'))).toEqual(['secrets', ['secrets']])
  })

  it('rejects a panel whose tab is not a boolean', async () => {
    const registry = createRegistry()
    await registry.setLoaders({
      [path('odd')]: async () =>
        module({
          panels: [{ id: 'x', title: 'X', component: component('x'), tab: 'no' as never }],
        }),
    })
    expect(registry.getSnapshot()[0].error).toMatch(/^panels must be .*tab\?/)
  })
})
