/** Server action handlers checked against their refs in `refs.ts`, so the browser's types and the server can't drift. */
import type { JsonValue } from '@earendil-works/chord/json'
import type { ActionContext } from '../server/actions.ts'
import type { ActionRef } from '../shared/extension-api.ts'

/**
 * Arguments as a handler receives them: untrusted JSON (or null) that may carry the ref's argument names, each value
 * still to be validated. Reading a name the ref does not declare fails to compile.
 */
export type ActionInput<Args> = [Args] extends [null]
  ? JsonValue
  : Args extends object
    ? { readonly [K in keyof Args]?: unknown } | string | number | boolean | JsonValue[] | null
    : JsonValue

/** A handler built by `implementAction`: callable with any JSON, and carrying the ref it implements. */
export type TypedAction<Args, Result, Returned, Ctx> = ((args: JsonValue, ctx: Ctx) => Returned) & {
  readonly ref: ActionRef<Args, Result>
}

/**
 * The handler of the action `ref` names, for `export const actions = { [ref.name]: implementAction(ref, handler) }`:
 * the handler returns the ref's result and reads only the ref's argument names. `ctx` is the `ActionContext` unless
 * the handler declares a part of it.
 */
export function implementAction<
  Args,
  Result,
  Returned extends NoInfer<Result> | Promise<NoInfer<Result>>,
  Ctx = ActionContext,
>(
  ref: ActionRef<Args, Result>,
  handler: (args: ActionInput<NoInfer<Args>>, ctx: Ctx) => Returned,
): TypedAction<Args, Result, Returned, Ctx> {
  // Any JSON reaches a handler; ActionInput only names what it may look for, and the handler validates it.
  return Object.assign((args: JsonValue, ctx: Ctx) => handler(args as ActionInput<Args>, ctx), {
    ref,
  })
}
