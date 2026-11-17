import { defineEntry } from '@earendil-works/pi-durable'
import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { parseConversationId, parseEntryId } from '../../lib/ids.ts'
import { renderEntry } from '../../web/src/sdk/entry-renderer.tsx'

it('mounts a typed entry renderer for its kind and otherwise keeps the core rendering', () => {
  const token = defineEntry<{ label: string }>('example.result')
  const Renderer = renderEntry(token, ({ entry }) => {
    const [label] = useState(entry.data.label.toUpperCase())
    return createElement('span', null, label)
  })
  const entry = {
    id: parseEntryId(1),
    conversationId: parseConversationId(1),
    kind: token.kind,
    data: { label: 'done' },
  }
  expect(renderToStaticMarkup(createElement(Renderer, { entry, core: 'core' }))).toBe(
    '<span>DONE</span>',
  )
  expect(
    renderToStaticMarkup(
      createElement(Renderer, { entry: { ...entry, kind: 'other' }, core: 'core' }),
    ),
  ).toBe('core')
})
