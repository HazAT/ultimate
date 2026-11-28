export type Api<Name extends string, PhantomService> = {
  readonly name: Name
  readonly service?: PhantomService
}

export const defineApi =
  <Service>() =>
  <Name extends string>(name: Name): Api<Name, Service> => ({ name })

export type DocRef<PhantomValue> = {
  readonly kind: string
  readonly value?: PhantomValue
}

export const docRef = <T>(kind: string): DocRef<T> => ({ kind })

export type ActionRef<PhantomArgs, PhantomResult> = {
  readonly extension: string
  readonly name: string
  readonly args?: PhantomArgs
  readonly result?: PhantomResult
}

export const actionRef = <Args, Result>(
  extension: string,
  name: string,
): ActionRef<Args, Result> => ({
  extension,
  name,
})

export const coreTier = /^export const tier = 'core'$/m

export const extensionTests = 'test'
export const inExtensionTests = (path: string) => path.split('/')[1] === extensionTests

export const defaultOff: readonly string[] = [
  'cloud',
  'parallel',
  'tailscale',
  'health',
  'classify',
  'phase',
  'sounds',
  'acp',
  'push',
  'wire',
]

type SortedCycleNames = string[]
export type Catalogue = {
  apis: { name: string; owner?: string; provider?: string; needs: string[]; wants: string[] }[]
  missing: string[]
  cycles: SortedCycleNames[]
}
