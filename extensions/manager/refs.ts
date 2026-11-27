/**
 * The Extensions manager in the browser: every installed extension with its state and contract, the switches that turn
 * them on and off, and the project setup decision. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'
import type { ExtensionInfo } from '../../shared/protocol.ts'

/** The project's own `.ultimate` setup: whether it has any, the user's decision on it (null: undecided), its README. */
export type ProjectSetup = { config: boolean; decision: boolean | null; readme?: string }

/** One extension as the Extensions panel lists it; `readme` is the first sentence of its README. */
export type Described = Pick<
  ExtensionInfo,
  'name' | 'source' | 'replaces' | 'enabled' | 'layer'
> & {
  readme: string
}

/** What the Extensions panel shows when a row opens: the contract and the dependencies the catalogue knows of. */
export type ExtensionDetails = {
  /** The first sentence of the api.ts or refs.ts doc comment; '' without either. */
  summary: string
  /** APIs and extension points it provides, and the points it declares for others. */
  provides: string[]
  declares: string[]
  needs: string[]
  wants: string[]
  /** Durable events its refs.ts defines. */
  events: string[]
}

/** No arguments → every installed extension with its source, state and README line. */
export const ExtensionsAction = actionRef<null, Described[]>('manager', 'extensions')
/** `{ name }` → the loaded extension's contract summary, catalogue entries and events. */
export const DetailsAction = actionRef<{ name: string }, ExtensionDetails>('manager', 'details')
/** `{ local }` → `{ project }`: decide whether this project's own setup applies. */
export const DecideAction = actionRef<{ local: boolean }, { project: ProjectSetup }>(
  'manager',
  'decide',
)
/**
 * `{ name, enabled, scope }` → `{ ok }`: turn extension `name` on or off in the user's or (once the project's setup is
 * chosen) the project's settings, then reload extensions.
 */
export const SetExtensionAction = actionRef<
  { name: string; enabled: boolean; scope: 'user' | 'project' },
  { ok: boolean }
>('manager', 'setExtension')
/** No arguments → `{ ok }`: copy the project's extension choices into the user's settings, then reload extensions. */
export const AdoptProjectSetupAction = actionRef<null, { ok: boolean }>(
  'manager',
  'adoptProjectSetup',
)
