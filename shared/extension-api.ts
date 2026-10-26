/**
 * The typed contract of one extension service: a name plus a phantom service type. Lives in an extension's `api.ts`;
 * the provider passes it to `host.implement`, consumers to `host.need` or `host.want`. Browser-safe.
 */
export type Api<Name extends string, Service> = {
  readonly name: Name
  /** Phantom: carries the service type; never set at runtime. */
  readonly service?: Service
}

/** `defineApi<WorkspaceService>()('workspaces')`: the service type is explicit, the name is inferred. */
export const defineApi =
  <Service>() =>
  <Name extends string>(name: Name): Api<Name, Service> => ({ name })

/**
 * A document the browser reads by kind, typed by its value: the web half of a server facet's `docs`. Lives in an
 * extension's `refs.ts`; `useDoc(ref)` and `useDocOf(conversation, ref)` take it. Browser-safe.
 */
export type DocRef<T> = {
  readonly kind: string
  /** Phantom: carries the value type; never set at runtime. */
  readonly value?: T
}

/** `docRef<WorkspaceIndex>('ultimate.workspaces')`: the document kind with its value type. */
export const docRef = <T>(kind: string): DocRef<T> => ({ kind })

/**
 * An action of an extension's server facet (`export const actions`), typed by its arguments and result. Lives in an
 * extension's `refs.ts`; `api.action(ref, args)` and `useAction(ref, args)` take it. Browser-safe.
 */
export type ActionRef<Args, Result> = {
  readonly extension: string
  readonly name: string
  /** Phantom: carries the argument type; never set at runtime. */
  readonly args?: Args
  /** Phantom: carries the result type; never set at runtime. */
  readonly result?: Result
}

/** `actionRef<{ id: number }, WorkspaceInfo | null>('workspaces', 'info')`; actions without arguments take `null`. */
export const actionRef = <Args, Result>(
  extension: string,
  name: string,
): ActionRef<Args, Result> => ({
  extension,
  name,
})

/**
 * How an extension joins the core tier: this exact line in its `api.ts`. Core-tier extensions are always on and depend
 * only on other core-tier extensions; discovery and the `core-tier-deps` lint rule read it from the file's text.
 */
export const coreTier = /^export const tier = 'core'$/m

/**
 * Built-ins that ship installed but off: each needs something of its own (a key, a service, a Worker) or changes how
 * the machine behaves. `extensions.enable` in user or project settings turns one on.
 */
export const defaultOff: readonly string[] = [
  'cloud',
  'parallel',
  'exa',
  'tailscale',
  'health',
  'classify',
  'phase',
  'sounds',
  'voice-live',
]

/** Who provides and who consumes each API, as `host.catalogue()` reports it. */
export type Catalogue = {
  /** `owner` is set on an extension point `<owner>.<point>`: the extension that declares it in its api.ts. */
  apis: { name: string; owner?: string; provider?: string; needs: string[]; wants: string[] }[]
  /** Needed APIs no enabled extension provides. */
  missing: string[]
  /**
   * Groups of extensions that depend on each other in a cycle, each sorted. A need or want depends on the API's owner
   * (a service's provider); the provider of an extension point depends on the point's owner.
   */
  cycles: string[][]
}
