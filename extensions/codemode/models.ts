import { defineDoc, hook, ToolTask } from '@earendil-works/pi-durable'
import type { Harness } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const MAX_MODEL_CALLS = 1_000
const MODEL_TOOL_PREFIX = 'pi.codemode.models.'

const Admissions = defineDoc<{
  keys: string[]
  usage: Record<string, { input: number; cost: number }>
}>({
  kind: 'codemode.model-calls',
  scope: 'task',
  version: 1,
  initial: () => ({ keys: [], usage: {} }),
  checkpointWhen: checkpointEvery(100),
})

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const dollars = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 3,
})

export const modelCallLimits = (harness: () => Harness) =>
  hook(ToolTask, {
    async beforeTool(call, api, context) {
      if (!call.name.startsWith(MODEL_TOOL_PREFIX) || !call.parent) return undefined
      const parent = call.parent.taskId
      const admitted = await harness().commit(async (tx) => {
        const input = (await tx.task(api.taskId))?.input
        const key =
          input && typeof input === 'object' && 'key' in input && typeof input.key === 'string'
            ? input.key
            : undefined
        if (key === undefined) throw new Error('Missing nested model call')
        const { keys } = await tx.doc(Admissions, parent)
        if (keys.includes(key)) return true
        if (keys.length >= MAX_MODEL_CALLS) return false
        keys.push(key)
        return true
      }, context)
      return admitted
        ? undefined
        : { block: `models: at most ${MAX_MODEL_CALLS} classify/generateImages calls per script` }
    },
    async afterTool(call, result, api, context) {
      if (call.name.startsWith(MODEL_TOOL_PREFIX) && call.parent) {
        if (result.structuredOutput === undefined) return undefined
        const parent = call.parent.taskId
        const usage = { input: result.usage?.input ?? 0, cost: result.usage?.cost?.total ?? 0 }
        await harness().commit(async (tx) => {
          ;(await tx.doc(Admissions, parent)).usage[call.id] = usage
        }, context)
        return undefined
      }
      if (call.name !== CODEMODE_TOOL_NAME || call.parent) return undefined
      const usage = Object.values(
        (await api.snapshot(Admissions, api.taskId, context))?.usage ?? {},
      )
      if (!usage.length) return undefined
      const calls = usage.length
      const tokens = usage.reduce((sum, item) => sum + item.input, 0)
      const cost = usage.reduce((sum, item) => sum + item.cost, 0)
      const text = `models: ${calls} ${calls === 1 ? 'call' : 'calls'}, ${compact.format(tokens).toLowerCase()} input tokens, ≈${dollars.format(cost)}`
      return { ...result, output: [...(result.output ?? []), { type: 'text', text }] }
    },
  })
