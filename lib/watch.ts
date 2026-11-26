import type { FSWatcher } from 'node:fs'

export function closeOnWatchError(
  watcher: FSWatcher,
  directory: string,
  report: (message: string, error: Error) => void = console.error,
) {
  watcher.on('error', (error) => {
    report(`Cannot watch ${directory}:`, error)
    watcher.close()
  })
  return watcher
}
