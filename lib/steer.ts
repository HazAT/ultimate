import { InboxDoc } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'

export async function watchSteer(
  api: Pick<ToolExecutionApi, 'watchDoc' | 'conversationId'>,
  context: Context,
  releaseWaitingToolForSteer: () => void,
) {
  const inbox = await api.watchDoc(InboxDoc, api.conversationId, context)
  const inspect = (value: NonNullable<typeof inbox>['value']) => {
    const steerNotFollowUpQueued = value?.items.some((item) => item.mode === 'steer')
    if (steerNotFollowUpQueued) releaseWaitingToolForSteer()
  }
  inbox?.start(async (call) => {
    if (call.kind === 'value') inspect(call.value)
  })
  if (inbox) inspect(inbox.value)
  return async () => void (await inbox?.stop())
}
