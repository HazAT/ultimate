/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show } from 'solid-js'
import { ContributionError } from '../app/contribution-error.solid.tsx'
import { Contribution } from './react-island.solid.tsx'
import { isSolid, provisionsOf, useExtensions } from './solid.ts'
import type { Point } from './types.ts'

export { Card } from '../app/card.solid.tsx'
/** A card that folds to one quiet line in compact mode; `label` names its button. The reader's choice survives reloads. */
export { Fold, useFold } from '../app/fold.solid.tsx'
export { MessageActions } from '../app/message-actions.solid.tsx'
export { UserText, UserView } from '../app/user-turn.solid.tsx'
export { useToolDuration } from '../app/tool-call.solid.tsx'
/** The value the last provider in discovery order gives for `point`, from a React provider's hook. */
export { useProvided } from './react-island.solid.tsx'

/**
 * Renders what each extension provides for `point` with `input`, in discovery order (`last` keeps only the last
 * provider). A provider contributed as `provide(Point, island(C))` renders as Solid, `C` taking the live input as its
 * props; any other provider's hook renders as React with a copy of the input taken whenever any of it changes. A
 * provider that throws shows its error inline and the rest still render.
 */
export function Provided<Input extends object>(props: {
  point: Point<Input, unknown>
  input: Input
  last?: boolean
}) {
  const extensions = useExtensions()
  const items = createMemo(() => {
    const all = provisionsOf(extensions(), props.point.point).map((provision) => ({
      extension: provision.extension,
      version: provision.version,
      component: provision.use,
    }))
    return props.last ? all.slice(-1) : all
  })
  const copy = createMemo(() => JSON.parse(JSON.stringify(props.input)) as Record<string, unknown>)
  return (
    <For each={items()} keyed={(item) => `${item.extension}:${item.version}`}>
      {(item) => (
        <Show fallback={<Provider item={item()} input={copy()} />} when={isSolid(item().component)}>
          <Provider item={item()} input={props.input as Record<string, unknown>} />
        </Show>
      )}
    </For>
  )
}

function Provider(props: {
  item: { extension: string; version: number; component: unknown }
  input: Record<string, unknown>
}) {
  return (
    <Contribution
      fallback={(extension, error) => (
        <ContributionError error={error} extension={extension} inline />
      )}
      item={props.item}
      props={props.input}
    />
  )
}
