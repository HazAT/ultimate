import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { LandingCard } from '../../extensions/workspaces/landing.tsx'

// The screenshot a submitter took: entry 9 of its conversation 43.
const shot = {
  id: 9,
  conversationId: 43,
  kind: 'pi.tool-result',
  model: [
    {
      role: 'toolResult',
      content: [
        { type: 'text', text: 'PNG' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    },
  ],
} as unknown as EntryRecord
let transcript = [shot]
vi.mock('@/sdk', async () => ({
  api: { history: () => new Promise(() => {}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  Fold: ({ summary, children }: { summary: ReactNode; children: ReactNode }) =>
    createElement('div', null, summary, children),
  Provided: () => null,
  useConversationSummary: () => undefined,
  useUltimate: () => ({ switchConversation: () => {} }),
  useTranscript: () => transcript,
}))
vi.mock('@/components/ai/message', () => ({
  MentionText: ({ text }: { text: string }) => createElement('span', null, text),
}))
vi.mock('../../extensions/conversations/ui.tsx', () => ({
  useStandingName: () => undefined,
  FeatureTag: ({ feature }: { feature: string }) => createElement('span', null, feature),
}))

/** The landing card as the submitter's report shows it. */
const card = (images?: { entry: number }) =>
  renderToStaticMarkup(
    createElement(LandingCard, {
      card: 5,
      tone: 'landed',
      headline: 'Landed abc1234 on main',
      from: 43,
      sha: 'abc1234def5678',
      images,
    }),
  )

it('shows the submission\u2019s screenshots as one row of evidence', () => {
  transcript = [shot]
  const html = card({ entry: 9 })
  expect(html).toContain('data-landing-evidence')
  expect(html).toContain('src="data:image/png;base64,AAAA"')
  expect(html).toContain('alt="Landing screenshot 1"')
})

it('shows no evidence row without images', () => {
  transcript = [shot]
  expect(card()).not.toContain('data-landing-evidence')
})

it('still reads while the evidence entry is not loaded yet', () => {
  transcript = []
  const html = card({ entry: 9 })
  expect(html).toContain('Landed abc1234 on main')
  expect(html).not.toContain('data-landing-evidence')
})
