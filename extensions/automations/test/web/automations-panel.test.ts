import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AutomationListItem } from '../../types.ts'

const shell = vi.hoisted(() => ({
  requested: undefined as number | undefined,
  list: [] as AutomationListItem[],
  expanded: [] as string[],
  action: vi.fn<(ref: { name: string }) => Promise<unknown>>(),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  // Server rendering has no store to subscribe to: read each external store's current value.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}))
vi.mock('@/sdk', () => ({
  api: { action: shell.action },
  defineWebExtension: (extension: unknown) => extension,
  useToolDuration: () => undefined,
  formatKeys: () => [],
  useEvent: () => {},
  events: { emit: () => {} },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: (error: unknown) => String(error),
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  formatTime: (date: Date) => date.toISOString(),
  shortenPath: (path: string) => path,
  useAction: (
    ref: { name: string },
    args: { id?: string; lines?: number; schedule?: unknown } | null,
  ) => ({
    data:
      ref.name === 'events'
        ? [
            {
              name: 'workspaces.check',
              description: 'A landing check finished',
              fields: { result: 'passed | failed' },
            },
          ]
        : args === null
          ? { definitions: [] }
          : args.schedule !== undefined
            ? {
                description: 'Every 15 minutes',
                schedule: { kind: 'every', ms: 900000 },
                next: [1300000, 2200000],
              }
            : args.lines === undefined
              ? { path: `/automations/${args.id}/run`, text: '#!/bin/sh' }
              : { text: 'checking\nFIRE build green' },
    refetch: () => Promise.resolve(undefined),
  }),
  useCommands: () => [],
  useConversations: () => [],
  useExtensionUiState: <T>(key: string, initial: T) => [
    key === 'expanded' ? shell.expanded : initial,
    () => {},
  ],
  useNow: () => 1_000_000,
  useStore: (select: (state: { requested?: number; ui: object }) => unknown) =>
    select({ requested: shell.requested, ui: {} }),
  useSystem: () => undefined,
  useTasks: () => undefined,
  useUiState: <T>(_key: string, initial: T) => [initial, () => {}],
  useUltimate: () => ({
    conversationId: shell.requested,
    openPanel: () => {},
    showSurface: () => {},
    switchConversation: () => {},
  }),
  useViewport: () => 'desktop',
}))
vi.mock('../../parts.tsx', async (original) => ({
  ...(await original<typeof import('../../parts.tsx')>()),
  useAutomations: () => ({ data: shell.list }),
}))
vi.mock('@/components/ai/message', () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/ui/switch', () => ({
  Switch: (props: { 'aria-label': string; checked: boolean }) =>
    createElement('button', {
      role: 'switch',
      'aria-label': props['aria-label'],
      'aria-checked': props.checked,
    }),
}))
// Inline the dialog for static rendering; no browser portal is available in these component tests.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
}))
Object.assign(globalThis, { document: { visibilityState: 'visible' }, window: {} })
const { AutomationsPanel } = await import('../../panel.tsx')
const { Chip } = await import('../../chip.tsx')
const { AutomationForm, contextCondition } = await import('../../form.tsx')

const base = (id: string, createdAt: number, extra: Partial<AutomationListItem>) =>
  ({
    id,
    name: `automation ${id}`,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    subscribers: [],
    runs: [],
    fires: 0,
    alive: true,
    ...extra,
  }) satisfies AutomationListItem
const script = (
  state: NonNullable<AutomationListItem['script']>['state'],
  conversationId: number,
) => ({
  ask: 'watch it',
  once: false,
  conversationId,
  state,
})
const schedule = base('A1', 300, {
  schedule: { kind: 'every', ms: 900_000 },
  prompt: 'say hi',
  nextAt: 1_300_000,
})
const watching = base('A2', 200, { script: script('running', 41), subscribers: [7], fires: 1 })
const failed = base('ci-watch', 100, {
  scope: 'project',
  enabled: false,
  script: { ...script('failed', 42), error: 'exit 2' },
  subscribers: [7],
})

const render = () => renderToStaticMarkup(createElement(AutomationsPanel))
beforeEach(() => {
  shell.requested = undefined
  shell.list = [schedule, watching, failed]
  shell.expanded = []
  shell.action
    .mockReset()
    .mockImplementation((ref) => Promise.resolve(ref.name === 'list' ? shell.list : schedule))
})

it('lists both kinds, worst first: the failed script before the schedule and the watching script', () => {
  shell.requested = 7
  const html = render()
  const order = [...html.matchAll(/data-automation="([^"]+)"/g)].map((match) => match[1])
  expect(order).toEqual(['ci-watch', 'A1', 'A2'])
  expect(html).toContain('data-look="failed"')
  expect(html).toContain('Every 15 minutes')
  expect(html).toContain('aria-label="script"')
  expect(html).toContain('aria-label="schedule"')
  expect(html).toContain('1 need attention')
})

it("shows a script's output beside its watcher, with FIRE lines marked", () => {
  shell.requested = 42
  const html = render()
  expect(html).toContain('data-automation-script="ci-watch"')
  expect(html).toContain('/automations/ci-watch/run')
  expect(html).toContain('exit 2')
  expect(html).toMatch(/border-success[^>]*><span[^>]*>FIRE<\/span> build green/)
  expect(html).not.toContain('data-automation="A1"')
})

const eventAutomation = base('A3', 400, {
  event: { name: 'workspaces.check', where: { result: 'failed' }, sinceEvent: 0 },
  subscribers: [7],
})
const contextAutomation = base('A4', 500, {
  condition: {
    metric: 'context',
    of: '@ultimate',
    above: 80,
    cooldownMs: 3600000,
    armed: true,
    value: 64,
  },
  subscribers: [7],
})

it('shows bolt triggers, filters, context fill and event fire history without scheduling placeholders', () => {
  shell.list = [eventAutomation, contextAutomation]
  let html = render()
  expect(html).toContain('aria-label="event"')
  expect(html).toContain('aria-label="context"')
  expect(html).toContain('on workspaces.check where result=failed')
  expect(html).toContain('when @ultimate context ≥ 80%')
  expect(html).toContain('64% now')
  expect(html).toContain('never fired')
  expect(html).not.toContain('scheduling…')
  shell.list = [
    { ...eventAutomation, fires: 3, lastFireAt: 900000 },
    {
      ...contextAutomation,
      lastFireAt: 900000,
      condition: { ...contextAutomation.condition!, armed: false },
    },
  ]
  html = render()
  expect(html).toContain('fired 3 times · last')
  expect(html).toContain('re-arms below 70%')
})

it('warns when a low context threshold cannot re-arm, both on the list and in the form', () => {
  const low = {
    ...contextAutomation,
    lastFireAt: 900000,
    condition: { ...contextAutomation.condition!, above: 10, armed: false },
  }
  shell.list = [low]
  expect(render()).toContain('won&#x27;t re-arm')
  const form = renderToStaticMarkup(
    createElement(AutomationForm, {
      open: true,
      automation: low,
      onOpenChange: () => {},
      onSaved: () => {},
      onClosed: () => {},
    }),
  )
  expect(form).toContain('After firing, it cannot re-arm at a threshold of 10% or less.')
})

it('renders the third trigger, event descriptions and context re-arm defaults in the form', () => {
  const form = (automation?: AutomationListItem) =>
    renderToStaticMarkup(
      createElement(AutomationForm, {
        open: true,
        automation,
        onOpenChange: () => {},
        onSaved: () => {},
        onClosed: () => {},
      }),
    )
  expect(form()).toContain('When Ultimate…')
  const context = form(contextAutomation)
  expect(context).toContain('value="@ultimate"')
  expect(context).toContain('value="80"')
  expect(context).toContain('Fires once, again after it drops below 70% and an hour has passed.')
  expect(context).toContain('Each fire wakes the agent, which costs tokens.')
  const event = form(eventAutomation)
  expect(event).toContain('A landing check finished · workspaces.check')
  expect(event).toContain('result (optional filter)')
  expect(event).toContain('value="failed"')
  expect(event).not.toContain('Wake this conversation')
})

it('refuses a cleared number field instead of saving it as 0', () => {
  const draft = { of: '@ultimate', above: '80', cooldownMinutes: '15', idleHours: '0' }
  expect(contextCondition(draft)).toMatchObject({ above: 80, cooldownMs: 900000, idleFor: 0 })
  expect(contextCondition({ ...draft, cooldownMinutes: '' })).toBeUndefined()
  expect(contextCondition({ ...draft, above: ' ' })).toBeUndefined()
  expect(contextCondition({ ...draft, idleHours: '' })).toBeUndefined()
})

it('colours the chip by the worst state and hides it when nothing is active', () => {
  const chip = () => renderToStaticMarkup(createElement(Chip))
  expect(chip()).toContain('data-automations-chip="failed"')
  expect(chip()).toContain('3 automations')
  shell.list = [{ ...schedule, enabled: false }]
  expect(chip()).toBe('')
  shell.list = []
  expect(chip()).toBe('')
})
