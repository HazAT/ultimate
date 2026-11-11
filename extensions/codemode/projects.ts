/**
 * Reads of another project's stored history, for codemode's `{ project }` option: only from a running instance of it,
 * through lib/remote.ts. Nothing falls back to a copy.
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { locate, postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** What `codemode.read` answers: the same reads codemode offers for its own project. */
export const READS = ['conversations', 'entries', 'search', 'trace', 'traceTree', 'doc'] as const
export type Read = (typeof READS)[number]

/**
 * Run read `op` in `project`, on `machine` when one is named: undefined when it is this project, so the caller reads its
 * own storage.
 */
export async function readProject(
  host: ExtensionHost,
  { project, machine }: { project: string; machine?: string },
  op: Read,
  args: JsonValue[],
  signal?: AbortSignal,
): Promise<{ value: unknown } | undefined> {
  const target = await locate(host, project, machine)
  if ('current' in target) return undefined
  return { value: await postAction(target, 'codemode', 'read', { op, args }, signal) }
}
