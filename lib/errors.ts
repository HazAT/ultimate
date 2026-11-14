/**
 * The only ways product code lets an error go (`ultimate/no-silent-catch`). Each name says why ignoring that failure is
 * correct, so the reason is code, not a comment. Browser-safe.
 */

/** The `code` of a Node or DOM error (`ENOENT`, `AbortError`…), if it has one. */
export function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  if (error instanceof DOMException) return error.name
  return undefined
}

/** A file or directory that is not there. */
export const isMissing = (error: unknown) => errnoCode(error) === 'ENOENT'

/** A call its caller aborted. */
export const isAborted = (error: unknown) =>
  errnoCode(error) === 'AbortError' || (error instanceof Error && error.name === 'AbortError')

/** `.catch(ignoring(isMissing))`: resolves to undefined for the expected failure; any other still rejects. */
export const ignoring =
  (...expected: ((error: unknown) => boolean)[]) =>
  (error: unknown): undefined => {
    if (expected.some((is) => is(error))) return undefined
    throw error
  }

/** `.catch(meansNone)`: a failure here only means there is nothing, such as no commit, no repository or no answer. */
export const meansNone = (_error: unknown): undefined => undefined

/** `onError: keepLast` or `.catch(keepLast)`: a failed read keeps its last answer, quietly; the next read asks again. */
export const keepLast = (_error: unknown): undefined => undefined

/** `.catch(overshadowed)`: a cleanup that failed while another error, the one that matters, is being reported. */
export const overshadowed = (_error: unknown): undefined => undefined

/**
 * `inBackground(work)`: starts work nobody waits for, whose own catch reports its failure. A failure that still escapes
 * is a bug, logged loudly instead of crashing the process as an unhandled rejection.
 */
export function inBackground(work: Promise<unknown>): void {
  work.catch((error: unknown) =>
    console.error('Background work failed without reporting it:', error),
  )
}

/** `.catch(retriedLater)`: a cleanup whose leftover the next run removes, so this one failing loses nothing. */
export const retriedLater = (_error: unknown): undefined => undefined

/** `queue = settled(work)`: a queue waits for `work` to end; its caller already received the failure. */
export const settled = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  )
