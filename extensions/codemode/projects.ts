import type { JsonValue } from '@earendil-works/chord/json'
import { locate, postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export const READS = ['conversations', 'entries', 'search', 'trace', 'traceTree', 'doc'] as const
export type Read = (typeof READS)[number]

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
