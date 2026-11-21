/** @jsxImportSource @solidjs/web */
import { dispatch } from '@ui-sdk/core'
import type { ChangeSource } from '@ui-sdk/core'
import { writingAs } from '../../sdk/hooks.ts'

export type SourcedAction = (
  value: string,
  details: { event?: Event; source: ChangeSource },
) => unknown

export function runAsItsSource(
  action: SourcedAction | undefined,
  value: string,
  details: { event?: Event },
) {
  let result: unknown
  dispatch(
    {
      options: () => ({
        onAction: (ran: string, resolved: { source: ChangeSource }) =>
          writingAs(resolved.source, () => {
            result = action?.(ran, { event: details.event, source: resolved.source })
          }),
      }),
    },
    'onAction',
    value,
    { reason: 'item-press', event: details.event },
  )
  return result
}
