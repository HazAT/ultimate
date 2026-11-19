/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/core/agent'
import { Input } from '@ui-sdk/solid/input'
import { Switch, SwitchThumb } from '@ui-sdk/solid/switch'
import { flush } from 'solid-js'
import { expect, it } from 'vitest'
import { scopeOf } from '../../../../web/src/sdk/conversation-scope.tsx'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { createRecorder } from '../../recorder.ts'
import type { Batch } from '../../recorder.ts'

const SECRET = 'hunter2-token'
const agent = createAgent()

function Form() {
  return (
    <>
      <div data-agent-secret>
        <Input aria-label="API token" />
      </div>
      <div data-agent-hidden>
        <Switch aria-label="Hidden setting">
          <SwitchThumb />
        </Switch>
      </div>
    </>
  )
}

function recording() {
  const requests: Batch[] = []
  const recorder = createRecorder({
    driven: false,
    locate: (element: HTMLElement | undefined) => {
      const conversation = scopeOf(element ?? null)
      return conversation === undefined ? {} : { conversation }
    },
    send: async (batch) => {
      requests.push(JSON.parse(JSON.stringify(batch)) as Batch)
    },
  })
  return { recorder, requests, stop: agent.subscribe(recorder.observe) }
}

it('sends a change to a secret field redacted, so neither the request nor its event holds the value', async () => {
  renderSolid(() => <Form />)
  const { recorder, requests, stop } = recording()
  const result = await agent.act({
    steps: [{ ref: 'API token', action: 'setValue', args: [SECRET] }],
  })
  flush()
  stop()
  expect(result).toMatchObject({ ok: true })
  await recorder.flush(false)
  expect(requests).toEqual([
    {
      changes: [
        expect.objectContaining({
          label: 'API token',
          key: 'value',
          value: '[redacted]',
          source: 'agent',
        }),
      ],
    },
  ])
  expect(JSON.stringify(requests)).not.toContain(SECRET)
})

it('records nothing for a control inside data-agent-hidden, from an agent or a person', async () => {
  const container = renderSolid(() => <Form />)
  const { recorder, requests, stop } = recording()
  const result = await agent.act({
    steps: [{ ref: 'Hidden setting', action: 'setChecked', args: [true] }],
  })
  container.querySelector<HTMLButtonElement>('[aria-label="Hidden setting"]')!.click()
  flush()
  stop()
  expect(result).toMatchObject({ ok: false })
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  await recorder.flush(false)
  expect(requests).toEqual([])
})

it('records a control inside a conversation scope against that conversation', async () => {
  const container = renderSolid(() => (
    <div data-conversation-scope="42">
      <Switch aria-label="Side setting">
        <SwitchThumb />
      </Switch>
    </div>
  ))
  const { recorder, requests, stop } = recording()
  container.querySelector<HTMLButtonElement>('[aria-label="Side setting"]')!.click()
  flush()
  stop()
  await recorder.flush(false)
  expect(requests).toEqual([
    {
      conversation: 42,
      changes: [expect.objectContaining({ label: 'Side setting' })],
    },
  ])
})

it('records typing in a text field once, when it commits, without the typed or deleted text', async () => {
  const container = renderSolid(() => <Input aria-label="Notes" />)
  const { recorder, requests, stop } = recording()
  const field = container.querySelector<HTMLInputElement>('input')!
  const edit = (text: string, from: number, to: number) => {
    field.setRangeText(text, from, to, 'end')
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  }
  field.focus()
  edit('typed-secret', 0, 0)
  edit('', 6, 12)
  await recorder.flush(false)
  expect(requests).toEqual([])
  edit('kept-words', 0, 6)
  field.dispatchEvent(new Event('change', { bubbles: true }))
  flush()
  stop()
  await recorder.flush(false)
  expect(requests).toEqual([
    {
      changes: [
        {
          component: 'input',
          label: 'Notes',
          key: 'value',
          value: '[value]',
          previous: '[value]',
          source: 'programmatic',
          reason: 'input-change',
        },
      ],
    },
  ])
  expect(JSON.stringify(requests)).not.toMatch(/typed|kept|secret/)
})
