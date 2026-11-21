import type { ComponentType } from 'react'
import { isReact } from '../sdk/framework.ts'
import { island } from './island.tsx'

const wrapped = new WeakMap<object, ComponentType<never>>()

/** A contribution as a React component: a React one as it is, a Solid one wrapped once in an island. */
export function asReact(component: unknown): ComponentType<never> {
  if (isReact(component)) return component as ComponentType<never>
  let react = wrapped.get(component as object)
  if (!react) {
    react = island(component as never) as ComponentType<never>
    wrapped.set(component as object, react)
  }
  return react
}
