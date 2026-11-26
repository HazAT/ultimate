#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'

assert.deepEqual(process.argv.slice(2), ['acp'])
const sessionId = 'fake-session'
let model = 'gemini-pro'
let loaded = false
let permission
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'gemini-pro', name: 'Gemini Pro' },
      { value: 'gemini-flash', name: 'Gemini Flash' },
    ],
  },
]
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionUpdate, fields) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } } })
const answer = (id, text) => {
  update('agent_message_chunk', { content: { type: 'text', text } })
  send({ id, result: { stopReason: 'end_turn' } })
}

process.on('SIGTERM', () => {
  if (permission !== undefined) {
    assert.ok(process.cwd())
    update('agent_message_chunk', { content: { type: 'text', text: 'Final output before exit.' } })
  }
  process.stdout.write('', () => process.exit(0))
})

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line)
  switch (method) {
    case 'initialize':
      assert.deepEqual(params.clientCapabilities, {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      })
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
      break
    case 'session/new':
      assert.deepEqual(params.mcpServers, [])
      assert.equal(params.cwd, process.cwd())
      send({ id, result: { sessionId, configOptions: configOptions() } })
      break
    case 'session/load':
      assert.deepEqual(params, { sessionId, cwd: process.cwd(), mcpServers: [] })
      loaded = true
      update('agent_message_chunk', { content: { type: 'text', text: 'Do not replay this' } })
      send({ id, result: { configOptions: configOptions() } })
      break
    case 'session/set_config_option':
      assert.equal(params.sessionId, sessionId)
      assert.equal(params.configId, 'model')
      model = params.value
      send({ id, result: { configOptions: configOptions() } })
      break
    case 'session/prompt': {
      const text = params.prompt[0].text
      assert.deepEqual(params, { sessionId, prompt: [{ type: 'text', text }] })
      if (text.startsWith('Continue')) assert.equal(loaded, true)
      if (text !== 'Inspect the file') {
        answer(id, `Fake ACP: ${text}`)
        break
      }
      update('agent_thought_chunk', { content: { type: 'text', text: 'Ask before reading.' } })
      update('tool_call', {
        toolCallId: 'read-file',
        kind: 'read',
        status: 'in_progress',
        title: 'Read notes.txt',
      })
      permission = id
      send({
        id: 'permission',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'read-file', title: 'Read notes.txt' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      break
    }
    case 'session/cancel':
      send({ id: permission, result: { stopReason: 'cancelled' } })
      break
    case undefined:
      assert.equal(id, 'permission')
      if (result.outcome.outcome === 'cancelled') break
      assert.deepEqual(result.outcome, { outcome: 'selected', optionId: 'allow' })
      update('tool_call_update', {
        toolCallId: 'read-file',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'A note' } }],
      })
      answer(permission, `Read with ${model}.`)
      permission = undefined
      break
    default:
      assert.fail(`Unexpected method ${method}`)
  }
}
