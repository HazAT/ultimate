import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Feed, joined, shows } from '../../extensions/activity/feed.tsx'
import type { ActivityEvent } from '../../extensions/activity/feed.tsx'

vi.mock('@/sdk', async () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  formatAgo: (await import('../../lib/ago.ts')).formatAgo,
  definePoint: (name: string) => ({ name }),
  events: { emit: () => {} },
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
  useDocOf: () => ({ conversations: { '12': { feature: 'Activity Feed' } } }),
  useConversations: () => [{ id: 12, title: 'Build the Activity feed' }],
  useConversationSummary: (id?: number) =>
    [{ id: 12, title: 'Build the Activity feed' }].find((item: { id: number }) => item.id === id),
  useWorkspaceIndex: () => ({ queue: [], results: {} }),
}))
vi.mock('../../extensions/workspaces/landing.tsx', () => ({
  useGithubRepo: () => 'github.com/hazat/ultimate',
  CommitCount: ({ count, href }: { count: number; href?: string }) =>
    createElement('a', { href }, `${count} commits`),
}))

const now = Date.parse('2026-10-19T08:00:00Z')
const minutes = (n: number) => new Date(now - n * 60_000).toISOString()
const event = (id: number, name: string, at: string, data: unknown, context?: object) =>
  ({
    id,
    name,
    kind: `event.${name}`,
    v: 1,
    at,
    data,
    ...(context && { context }),
  }) as ActivityEvent

/** Each row as its kind, the text a person reads, its links and whether its notice is amber. */
function rows(list: ActivityEvent[]) {
  const html = renderToStaticMarkup(createElement(Feed, { events: list, now }))
  return [...html.matchAll(/<li[^>]*data-activity="([^"]+)"[^>]*>(.*?)<\/li>/g)].map(
    ([, kind, row]) => ({
      kind,
      text: row
        .replaceAll(/<[^>]+>/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim(),
      opens: /title="[^"]*open (#[\d/]+)"/.exec(row)?.[1],
      href: /href="([^"]+)"/.exec(row)?.[1],
      amber: row.includes('text-warning'),
    }),
  )
}

it('shows one row per event of its kinds, newest first as given, with what happened, where it leads and its age', () => {
  const feed = [
    event(9, 'sync.moved', minutes(1), { to: 'rog' }),
    event(8, 'ultimate.notice', minutes(3), {
      extension: 'tailscale',
      message: 'tailscale serve failed',
      level: 'warning',
    }),
    event(
      7,
      'workspaces.landed',
      minutes(5),
      {
        conversationId: 12,
        at: 40,
        sha: '45a315f0',
        base: '9057c43',
        target: 'main',
        title: 'Show recent events',
        feature: 'Activity Feed',
        commitCount: 3,
      },
      { conversationId: 30 },
    ),
    event(6, 'lineage.branched', minutes(90), { id: 12, from: 1, at: 7, intent: 'Build it' }),
    event(5, 'lineage.rooted', minutes(60 * 30), { id: 1, intent: 'Project context' }),
  ]
  // An event of another kind gets no row.
  expect(rows(feed)).toEqual([
    {
      kind: 'ultimate.notice',
      text: 'tailscale tailscale serve failed 3m',
      opens: undefined,
      href: undefined,
      amber: true,
    },
    {
      kind: 'workspaces.landed',
      text: 'Activity Feed Show recent events 3 commits 5m',
      opens: '#12/40',
      href: 'https://diffshub.com/hazat/ultimate/compare/9057c43...45a315f0',
      amber: false,
    },
    {
      kind: 'lineage.branched',
      text: 'Activity Feed #12 from #1 1h',
      opens: '#12',
      href: undefined,
      amber: false,
    },
    {
      kind: 'lineage.rooted',
      text: 'new root Project context #1 1d',
      opens: '#1',
      href: undefined,
      amber: false,
    },
  ])
})

it('opens the conversation a notice happened in, and names the sha when a landing has no title', () => {
  const [notice, landing] = rows([
    event(
      2,
      'ultimate.notice',
      minutes(0),
      { extension: 'cloud', message: 'paused', level: 'info' },
      {
        conversationId: 44,
      },
    ),
    event(1, 'workspaces.landed', minutes(2), {
      conversationId: 12,
      at: 3,
      sha: 'abcdef1234',
      base: '0123456',
      target: 'main',
      title: '',
      commitCount: 2,
    }),
  ])
  expect(notice).toMatchObject({ text: 'cloud paused now', opens: '#44', amber: false })
  expect(landing).toMatchObject({ text: 'abcdef1 2 commits 2m', opens: '#12/3' })
})

it('keeps only warnings and errors under Problems, and drops started backups everywhere', () => {
  const backup = (id: number, phase: string) =>
    event(id, 'cloud.backup', minutes(id), { project: 'ultimate', phase })
  const notice = (id: number, level: string) =>
    event(id, 'ultimate.notice', minutes(id), { extension: 'cloud', message: 'x', level })
  const list = [
    backup(1, 'done'),
    backup(2, 'failed'),
    backup(3, 'started'),
    notice(4, 'info'),
    notice(5, 'warning'),
  ]
  expect(list.filter((item) => shows('problems', item)).map((item) => item.id)).toEqual([2, 5])
  expect(list.filter((item) => shows('all', item)).map((item) => item.id)).toEqual([1, 2, 4, 5])
})

it('joins the live feed, rows it dropped and older pages without gaps or repeats', () => {
  const span = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) =>
      event(to - index, 'lineage.rooted', minutes(0), { id: to - index, intent: 'x' }),
    )
  // Paging started with live 101–200 and loaded 51–100; then the live feed moved on to 102–201.
  const kept = span(101, 200)
  const merged = joined([span(102, 201), kept, span(51, 100)]).map((item) => item.id)
  expect(merged).toEqual(Array.from({ length: 151 }, (_, index) => 201 - index))
})

it('stays quiet when nothing has happened', () => {
  const html = renderToStaticMarkup(createElement(Feed, { events: [], now }))
  expect(html).not.toContain('<li')
  expect(html).toContain('nothing has happened yet')
})
