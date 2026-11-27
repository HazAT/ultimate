import { createEffect } from 'solid-js'
import { api, errorMessage, pageAgent, ROOT, useDocOf, usePageVisible } from '@/sdk/solid'
import { AnswerAction, ClaimAction, PageAgentDoc } from './refs.ts'
import type { PageAgentCall } from './refs.ts'
import { pageId } from './ui.solid.tsx'

const tried = new Set<string>()

async function run(call: PageAgentCall) {
  const agent = pageAgent()
  const input = (call.input ?? {}) as Record<string, unknown>
  try {
    if (call.op === 'snapshot') return agent.snapshot()
    if (call.op === 'query') return await agent.query(input)
    return await agent.act(input as Parameters<typeof agent.act>[0])
  } catch (failure) {
    return { error: errorMessage(failure) }
  }
}

async function claimAndRun(call: PageAgentCall, visible: boolean) {
  const { claimed } = await api.action(ClaimAction, {
    id: call.id,
    page: pageId,
    visible,
  })
  if (!claimed) return
  const result = await run(call)
  await api.action(AnswerAction, {
    id: call.id,
    page: pageId,
    result: JSON.parse(JSON.stringify(result ?? null)),
  })
}

export function PageAgentRunner() {
  const doc = useDocOf(() => ROOT, PageAgentDoc)
  const pageVisible = usePageVisible()
  createEffect(
    () => ({
      calls: (doc()?.calls ?? []).map((call) => ({ ...call })),
      visible: pageVisible(),
    }),
    ({ calls, visible }) => {
      for (const id of tried) if (!calls.some((call) => call.id === id)) tried.delete(id)
      for (const call of calls) {
        if (call.claimed || tried.has(call.id)) continue
        if (call.page ? call.page !== pageId : !visible) continue
        tried.add(call.id)
        void claimAndRun(call, visible)
      }
    },
  )
  return null
}
