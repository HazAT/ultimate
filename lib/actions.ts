import type { JsonValue } from '@earendil-works/chord/json'
import type { ActionContext } from '../server/actions.ts'
import type { ActionRef } from '../shared/extension-api.ts'

export type ActionInput<Args> = [Args] extends [null]
  ? JsonValue
  : Args extends object
    ? { readonly [K in keyof Args]?: unknown } | string | number | boolean | JsonValue[] | null
    : JsonValue

export type TypedAction<Args, Result, Returned, Ctx> = ((args: JsonValue, ctx: Ctx) => Returned) & {
  readonly ref: ActionRef<Args, Result>
}

export function implementAction<
  Args,
  Result,
  Returned extends NoInfer<Result> | Promise<NoInfer<Result>>,
  Ctx = ActionContext,
>(
  ref: ActionRef<Args, Result>,
  validateAndHandle: (args: ActionInput<NoInfer<Args>>, ctx: Ctx) => Returned,
): TypedAction<Args, Result, Returned, Ctx> {
  return Object.assign(
    (untrustedJson: JsonValue, ctx: Ctx) =>
      validateAndHandle(untrustedJson as ActionInput<Args>, ctx),
    {
      ref,
    },
  )
}
