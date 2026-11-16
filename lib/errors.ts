export function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  if (error instanceof DOMException) return error.name
  return undefined
}

export const isMissing = (error: unknown) => errnoCode(error) === 'ENOENT'

export const isNoProcess = (error: unknown) => errnoCode(error) === 'ESRCH'

export const isPermissionDenied = (error: unknown) => errnoCode(error) === 'EPERM'

export function sqliteCode(error: unknown): number | undefined {
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number')
    return error.errcode
  return undefined
}

export const isAborted = (error: unknown) =>
  errnoCode(error) === 'AbortError' || (error instanceof Error && error.name === 'AbortError')

export const ignoring =
  (...expected: ((error: unknown) => boolean)[]) =>
  (error: unknown): undefined => {
    if (expected.some((is) => is(error))) return undefined
    throw error
  }

export const meansNone = (_error: unknown): undefined => undefined

export const keepLast = (_error: unknown): undefined => undefined

export const overshadowed = (_error: unknown): undefined => undefined

export function inBackground(workReportsOwnFailure: Promise<unknown>): void {
  workReportsOwnFailure.catch((error: unknown) =>
    console.error('Background work failed without reporting it:', error),
  )
}

export const retriedLater = (_error: unknown): undefined => undefined

export const settled = (workAlreadyReportedToCaller: Promise<unknown>): Promise<void> =>
  workAlreadyReportedToCaller.then(
    () => undefined,
    () => undefined,
  )
