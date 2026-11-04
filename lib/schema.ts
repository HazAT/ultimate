import { type Annotations, oneOf, type Schema } from '@earendil-works/pi-schema'

/**
 * One of the given strings, declared with `type: 'string'`. pi-schema's `oneOf()` emits a bare `{ enum }`, which is
 * valid JSON Schema, but Moonshot (Kimi, e.g. `opencode-go/kimi-k3.1-pro`) rejects the whole request with "type is not
 * defined". Found and first fixed in https://github.com/HazAT/ultimate/pull/79; drop this once `oneOf()` emits the type.
 */
export function strEnum<const V extends readonly string[]>(
  values: V,
  options?: Annotations<V[number]>,
): Schema<V[number]> {
  return { ...oneOf(values, options), type: 'string' }
}
