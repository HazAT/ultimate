/**
 * Builds the web UI into a folder, in a process of its own (`web.ts` starts it): the bundler keeps the memory it used
 * until its process ends. Its one argument is a JSON `WebBuildRequest`; it prints one JSON `WebBuildResult` line.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { gzipSync } from 'node:zlib'
import { build } from 'vite-plus'
import type { Rolldown } from 'vite-plus'
import { extensionModules } from './vite-extensions.ts'

export interface WebBuildRequest {
  ultimateRoot: string
  projectRoot: string
  userHome: string
  outDir: string
  cacheDir: string
  /** Facets left out of the bundle, by web.tsx path, with the error their loader reports instead. */
  broken: Record<string, string>
}
export type WebBuildResult = { inputs: string[] } | { error: { file?: string; message: string } }

const request = JSON.parse(process.argv[2]) as WebBuildRequest
let result: WebBuildResult
try {
  const output = (await build({
    configFile: resolve(request.ultimateRoot, 'vite.config.ts'),
    root: resolve(request.ultimateRoot, 'web'),
    cacheDir: request.cacheDir,
    logLevel: 'error',
    resolve: { alias: { '@': resolve(request.ultimateRoot, 'web/src') } },
    plugins: [
      extensionModules(request.ultimateRoot, request.projectRoot, request.userHome, request.broken),
    ],
    build: {
      outDir: request.outDir,
      emptyOutDir: true,
      // Debuggable as in dev: external maps resolve stack traces to source files, and kept names show in them and
      // in React's component stacks, for about 2% more gzipped bundle.
      sourcemap: true,
      rolldownOptions: {
        output: {
          keepNames: true,
          // Absolute paths: a resolved frame names the file to open, wherever the bundle folder is.
          sourcemapPathTransform: (source, map) => resolve(dirname(map), source),
        },
      },
      reportCompressedSize: false,
      chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
    },
  })) as Rolldown.RolldownOutput
  // Served precompressed: over a phone's link the bundle's 15 MB are about 4 MB gzipped.
  for (const item of output.output)
    if (/\.(js|css|svg|wasm)$/.test(item.fileName) && item.fileName.startsWith('assets/')) {
      const file = join(request.outDir, item.fileName)
      const content = await readFile(file)
      if (content.length > 1024) await writeFile(file + '.gz', gzipSync(content))
    }
  const inputs = output.output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds : []))
  result = {
    inputs: [...new Set(inputs.filter((id) => id.startsWith('/')).map((id) => id.split('?')[0]))],
  }
} catch (error) {
  const first = (error as { errors?: { id?: string; loc?: { file?: string }; message: string }[] })
    .errors?.[0]
  const message = stripVTControlCharacters(first?.message ?? String(error))
  // A transform error names its file only in the code frame's header: `╭─[ extensions/a/web.tsx:3:1 ]`.
  const framed = /╭─\[ (.+?):\d+:\d+ \]/.exec(message)?.[1]
  const file = first?.id ?? first?.loc?.file ?? (framed && resolve(request.ultimateRoot, framed))
  // The frame names the file relative to the Ultimate root, unreadable for one outside it.
  result = { error: { file, message: framed && file ? message.replace(framed, file) : message } }
}
process.stdout.write(JSON.stringify(result) + '\n')
