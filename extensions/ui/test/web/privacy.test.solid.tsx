/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/core/agent'
import { Input } from '@ui-sdk/solid/input'
import { Switch, SwitchThumb } from '@ui-sdk/solid/switch'
import { flush } from 'solid-js'
import { expect, it } from 'vitest'
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
    locate: () => ({}),
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
