import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { UpdateState } from '../../extensions/update/refs.ts'
import { itemOf, mergeOffered } from '../../extensions/update/item.ts'

const state = (extra: Partial<UpdateState> = {}): UpdateState => ({
  root: '/clone',
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  ...extra,
})
const layers = { core: false, bin: false, lockfile: false, live: true }

it('shows the quiet item while the clone is current', () => {
  expect(itemOf(state())).toBe('current')
  // An update that touched only hot-reloading code owes nothing: current again.
  expect(
    itemOf(
      state({
        updated: { ok: true, from: 'a', to: 'b', commits: 1, layers, install: 'skipped' },
      }),
    ),
  ).toBe('current')
})

it('shows nothing on a preview, and the prominent items while something is owed', () => {
  expect(itemOf(state({ preview: true }))).toBe('none')
  expect(itemOf(state({ behind: 3 }))).toBe('behind')
  expect(itemOf(state({ behind: 3, refused: 'dirty' }))).toBe('behind')
  expect(itemOf(state({ install: true }))).toBe('install')
  expect(itemOf(state({ restart: true }))).toBe('restart')
  expect(
    itemOf(
      state({
        updated: {
          ok: true,
          from: 'a',
          to: 'b',
          commits: 1,
          layers: { ...layers, core: true },
          install: 'skipped',
        },
      }),
    ),
  ).toBe('restart')
})

it('offers a smart merge unless conflicts are predicted', () => {
  const shape = { behind: 2, diverged: true as const }
  expect(mergeOffered(state({ ...shape, conflicts: false }))).toBe(true)
  // Unknown (git before 2.38): the merge stops on a conflict, so still offered.
  expect(mergeOffered(state({ ...shape, conflicts: undefined }))).toBe(true)
  expect(mergeOffered(state({ ...shape, conflicts: true }))).toBe(false)
  // A predicted conflict on a plain fast-forward is no merge at all.
  expect(mergeOffered(state({ behind: 2, conflicts: false }))).toBe(false)
  expect(mergeOffered(state({ ...shape, behind: 0, conflicts: false }))).toBe(false)
})

const shell = vi.hoisted(() => ({
  state: undefined as UpdateState | undefined,
  action: vi.fn<() => Promise<unknown>>(async () => undefined),
}))
vi.mock('@/sdk', () => ({
  api: { action: shell.action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  events: { emit: () => {} },
  formatAgo: () => 'just now',
  useAction: () => ({ data: shell.state, refetch: async () => undefined }),
  useRestart: () => ({ busy: false, run: () => {} }),
  useSystem: () => undefined,
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: unknown }) => children,
  PopoverTrigger: ({ children }: { children: unknown }) => children,
  PopoverContent: ({ children }: { children: unknown }) => children,
}))

/** The status line's markup for `current`, with the popover rendered open. */
async function markup(current: UpdateState) {
  shell.state = current
  const facet = (await import('../../extensions/update/web.tsx')).default as unknown as {
    slots: { 'statusline.right': { component: ComponentType }[] }
  }
  return facet.slots['statusline.right']
    .map(({ component }) => renderToStaticMarkup(createElement(component)))
    .join('')
}

/** A diverged clone: 3 commits of its own, 2 new upstream, by what merge-tree predicted. */
function diverging(conflicts: boolean | undefined, merge?: true): UpdateState {
  return state({
    root: '/clone',
    branch: 'main',
    behind: 2,
    ahead: 3,
    diverged: true,
    ...(conflicts === undefined ? {} : { conflicts }),
    ...(merge ? { merge } : {}),
    refused: 'main has diverged from origin/main',
    commits: [{ sha: 'a1b2c3d', subject: 'upstream change' }],
  })
}

it('offers Update now for a diverged clone without predicted conflicts', async () => {
  const html = await markup(diverging(false, true))
  expect(html).toContain('data-update-now')
  expect(html).not.toContain('data-update-merge')
  expect(html).toContain('no conflicts expected')
  expect(html).toContain('text-brand')
})

it('offers Update now when git cannot predict, saying the merge stops on conflicts', async () => {
  const html = await markup(diverging(undefined))
  expect(html).toContain('data-update-now')
  expect(html).toContain('stops on any conflict')
})

it('offers only Update with @ultimate when conflicts are predicted', async () => {
  const html = await markup(diverging(true, true))
  expect(html).toContain('data-update-merge')
  expect(html).not.toContain('data-update-now')
  expect(html).toContain('would conflict')
})

it('leaves Update now disabled on a predicted conflict the user must merge by hand', async () => {
  const html = await markup(diverging(true))
  expect(html).not.toContain('data-update-merge')
  expect(html).toContain('merge them by hand')
  // The disabled button stays, titled with the refusal, as any stuck clone's does.
  expect(html).toMatch(/data-update-now="[^"]*" disabled=""/)
  expect(html).toContain('text-warning')
})

it('shows a merged update with its undo, and the fix ask when its check failed', async () => {
  const failed = await markup(
    state({
      updated: {
        ok: true,
        from: 'a1b2c3d',
        to: 'e4f5a6b',
        commits: 2,
        layers: { ...layers, core: true },
        install: 'skipped',
        merged: true,
        restore: 'refs/ultimate-update/pre-20251102-103045-a1b2c3d4e5f6',
        check: 'failed',
        checkError: 'vp check: a type error in src.ts',
        fixable: true,
      },
    }),
  )
  expect(failed).toContain('Merged')
  expect(failed).toContain('pnpm check failed')
  expect(failed).toContain('vp check: a type error in src.ts')
  expect(failed).toContain('data-update-fix')
  expect(failed).toContain(
    'Undo: git reset --hard refs/ultimate-update/pre-20251102-103045-a1b2c3d4e5f6',
  )

  // A passed check needs no ask: only the undo remains.
  const passed = await markup(
    state({
      updated: {
        ok: true,
        from: 'a1b2c3d',
        to: 'e4f5a6b',
        commits: 2,
        layers,
        install: 'skipped',
        merged: true,
        restore: 'refs/ultimate-update/pre-20251102-103045-a1b2c3d4e5f6',
        check: 'passed',
      },
    }),
  )
  expect(passed).toContain('Merged')
  expect(passed).not.toContain('pnpm check failed')
  expect(passed).not.toContain('data-update-fix')
  expect(passed).toContain('Undo: git reset --hard')
})
