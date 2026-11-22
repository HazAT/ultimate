/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import facet from '../../web.solid.tsx'

const agent = createAgent()

it('loads only the recording whose play button is pressed, and shows when it is unavailable', async () => {
  const id = 'd680a5c1-fd58-4abf-a272-6f68a4fe394e'
  const call: ToolCallView = {
    id: 'capture-first',
    name: 'browser_video',
    status: 'done',
    args: {},
    output: 'Recipe saved.',
    diagnostics: [],
    images: [],
    details: { video: { id, title: 'Save recipe' } },
  }
  const Renderer = facet.tools!.browser_video
  const view = renderSolid(() => (
    <>
      <Renderer call={call} core={<span>{call.output}</span>} />
      <Renderer call={{ ...call, id: 'capture-second' }} core={null} />
    </>
  ))
  expect(view.textContent).toContain('Recipe saved.')
  expect(view.querySelector('video, img')).toBeNull()
  await expectDistinctAgentNames(agent)

  const control = agent
    .snapshot()
    .find((item) => item.label === 'Play video for tool call capture-first')!
  expect(await agent.act({ steps: [{ ref: control.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  flush()
  expect(view.querySelectorAll('video')).toHaveLength(1)
  const video = view.querySelector('video')!
  expect(video.controls).toBe(true)
  expect(video.getAttribute('src')).toBe(`/api/extensions/browser/files/${id}/video`)

  video.dispatchEvent(new Event('error'))
  flush()
  expect(view.querySelector('video')).toBeNull()
  expect(view.textContent).toContain('Video unavailable.')
})
