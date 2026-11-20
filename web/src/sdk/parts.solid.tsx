/** @jsxImportSource @solidjs/web */
import { createMemo, For } from 'solid-js'
import { ContributionError } from '../app/contribution-error.solid.tsx'
import { Contribution } from './react-island.solid.tsx'
import { provisionsOf, useExtensions } from './solid.ts'
import type { Point } from './types.ts'

/** The transcript's card: a bordered section with the brand accent on its left edge; `attention` while it waits on someone. */
export { Card } from '../app/card.solid.tsx'
/** A card that folds to one quiet line in compact mode; `label` names its button. The reader's choice survives reloads. */
export { Fold, useFold } from '../app/fold.solid.tsx'
/** A stored message's footer: its details, time, copy button and actions. */
export { MessageActions } from '../app/message-actions.solid.tsx'
/** A user's words with mentions linked, and a whole user turn as the transcript shows it. */
export { UserText, UserView } from '../app/user-turn.solid.tsx'
/** A tool call's running or final duration, as its header shows it. */
export { useToolDuration } from '../app/tool-call.solid.tsx'
/** A value one provider gives for `point` (the last in discovery order), from a React provider's hook. */
export { useProvided } from './react-island.solid.tsx'

/**
 * Renders what each extension provides for `point` with `input`, in discovery order (`last` keeps only the last
 * provider). A provider contributed as `provide(Point, island(C))` renders as Solid, `C` taking the input as its props;
 * any other provider's hook renders as React. A provider that throws shows its error inline and the rest still render.
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
  return (
    <For each={items()} keyed={(item) => `${item.extension}:${item.version}`}>
      {(item) => (
        <Contribution
          fallback={(extension, error) => (
            <ContributionError error={error} extension={extension} inline />
          )}
          item={item()}
          props={props.input as Record<string, unknown>}
        />
      )}
    </For>
  )
}
