import { type Annotations, oneOf, type Schema } from '@earendil-works/pi-schema'

export function strEnum<const V extends readonly string[]>(
  values: V,
  options?: Annotations<V[number]>,
): Schema<V[number]> {
  return { ...oneOf(values, options), type: 'string' }
}
