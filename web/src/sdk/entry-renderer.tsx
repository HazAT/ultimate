import type { Entry, TypedEntry } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ComponentProps, ComponentType } from 'react'
import type { EntryRenderer } from './types.ts'

/** Narrow a renderer's entry with its writer's token before mounting the component and its hooks. */
export function renderEntry<D extends JsonValue>(
  token: Entry<D>,
  Component: ComponentType<Omit<ComponentProps<EntryRenderer>, 'entry'> & { entry: TypedEntry<D> }>,
): EntryRenderer {
  return function TypedEntryRenderer(props) {
    return token.is(props.entry) ? <Component {...props} entry={props.entry} /> : props.core
  }
}
