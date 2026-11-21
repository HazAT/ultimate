import type { SystemInfo } from '../../../shared/protocol.ts'
import { shortenPath } from '../sdk/format.ts'

const MAX_NON_DEPENDENCY_STACK_FRAMES = 8

export function extensionPath(system: SystemInfo | undefined, name: string, file = '') {
  const info = system?.extensions.find((extension) => extension.name === name)
  if (!info) return `extensions/${name}${file}`
  return shortenPath(`${info.path}${file}`, {
    cwd: info.source === 'builtin' ? system?.code.ultimateRoot : system?.project.root,
    home: system?.machine.home,
  })
}

export function stackFrames(error: unknown) {
  return error instanceof Error ? error.stack?.replace(String(error), '').trim() : undefined
}

function shortFrame(system: SystemInfo | undefined, line: string) {
  const short = (path: string) =>
    shortenPath(path, { cwd: system?.code.ultimateRoot, home: system?.machine.home })
  return line
    .replace(/(?<=\()\/[^\s():]+/, short)
    .replace(/https?:\/\/[^/\s]+(\/@fs)?\/([^?:\s)]*)(\?[^:\s)]*)?/g, (_, fs, path) =>
      fs ? short(`/${path}`) : path,
    )
}

export function errorReport(
  system: SystemInfo | undefined,
  failure: { extension: string; error: string; context: string; stack?: string },
) {
  const source = system?.extensions.find((info) => info.name === failure.extension)?.source
  const frames = failure.stack
    ?.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/\/(node_modules|deps)\/|\(<anonymous>\)$/.test(line))
    .map((line) => shortFrame(system, line))
  const stack = frames && [...new Set(frames)].slice(0, MAX_NON_DEPENDENCY_STACK_FRAMES).join('\n')
  const build = system && `${system.build.id} · gen ${system.build.generation}`
  return [
    `Extension \`${failure.extension}\` failed: ${failure.context}.`,
    `Path: ${extensionPath(system, failure.extension)}${source ? ` (${source})` : ''}`,
    `Error: ${failure.error}`,
    stack && `Stack:\n\`\`\`\n${stack}\n\`\`\``,
    build && `Build: ${build}`,
  ]
    .filter(Boolean)
    .join('\n')
}
