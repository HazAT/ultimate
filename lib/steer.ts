import { InboxDoc } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'

/**
 * Call `steered` once a steer is queued in the calling conversation. A steer joins a run only after the tool round, so
 * a tool that waits would hold it; a waiting tool ends early instead and lets the steer be placed at once. Follow-ups
 * wait for the run's end anyway, so they never count. Returns the watch's stop.
 */
export async function watchSteer(
  api: Pick<ToolExecutionApi, 'watchDoc' | 'conversationId'>,
  context: Context,
  steered: () => void,
) {
  const inbox = await api.watchDoc(InboxDoc, api.conversationId, context)
  const inspect = (value: NonNullable<typeof inbox>['value']) => {
    if (value?.items.some((item) => item.mode === 'steer')) steered()
  }
  inbox?.start(async (call) => {
    if (call.kind === 'value') inspect(call.value)
  })
  if (inbox) inspect(inbox.value)
  return async () => void (await inbox?.stop())
}
