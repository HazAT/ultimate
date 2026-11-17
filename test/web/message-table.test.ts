import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { MessageResponse } from '../../web/src/components/ai/message.tsx'

vi.mock('../../web/src/sdk/hooks.ts', () => ({ useExtensions: () => [] }))

// Streamdown caps a table at 300px by default, so a long table scrolled inside its own box.
it('shows a long table at full height', () => {
  const rows = Array.from({ length: 20 }, (_, index) => `| ${index} | row ${index} |`)
  const html = renderToStaticMarkup(
    createElement(MessageResponse, null, ['| # | Name |', '| - | - |', ...rows].join('\n')),
  )
  expect(html).toContain('data-streamdown="table"')
  expect(html).not.toMatch(/max-height:\s*300px/)
})
