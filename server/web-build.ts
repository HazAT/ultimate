import { readFile, writeFile } from 'node:fs/promises'
import { webAliases } from '../lib/web-alias.ts'
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
  broken: Record<string, string>
}
export type WebBuildResult = { inputs: string[] } | { error: { file?: string; message: string } }

const externalSourceMapsForStackTraces = true
const retainReactComponentNames = true
const absoluteSourcePath = (source: string, map: string) => resolve(dirname(map), source)
const minPrecompressedBytes = 1024

const request = JSON.parse(process.argv[2]) as WebBuildRequest
let result: WebBuildResult
try {
  const output = (await build({
    configFile: resolve(request.ultimateRoot, 'vite.config.ts'),
    root: resolve(request.ultimateRoot, 'web'),
    cacheDir: request.cacheDir,
    logLevel: 'error',
    resolve: { alias: webAliases(request.ultimateRoot) },
    plugins: [
      extensionModules(request.ultimateRoot, request.projectRoot, request.userHome, request.broken),
    ],
    build: {
      outDir: request.outDir,
      emptyOutDir: true,
      sourcemap: externalSourceMapsForStackTraces,
      rolldownOptions: {
        output: {
          keepNames: retainReactComponentNames,
          sourcemapPathTransform: absoluteSourcePath,
        },
      },
      reportCompressedSize: false,
      chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
    },
  })) as Rolldown.RolldownOutput
  for (const item of output.output)
    if (/\.(js|css|svg|wasm)$/.test(item.fileName) && item.fileName.startsWith('assets/')) {
      const file = join(request.outDir, item.fileName)
      const content = await readFile(file)
      if (content.length > minPrecompressedBytes) await writeFile(file + '.gz', gzipSync(content))
    }
  const inputs = output.output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds : []))
  result = {
    inputs: [...new Set(inputs.filter((id) => id.startsWith('/')).map((id) => id.split('?')[0]))],
  }
} catch (error) {
  const first = (error as { errors?: { id?: string; loc?: { file?: string }; message: string }[] })
    .errors?.[0]
  const message = stripVTControlCharacters(first?.message ?? String(error))
  const relativeCodeFrameFile = /╭─\[ (.+?):\d+:\d+ \]/.exec(message)?.[1]
  const file =
    first?.id ??
    first?.loc?.file ??
    (relativeCodeFrameFile && resolve(request.ultimateRoot, relativeCodeFrameFile))
  result = {
    error: {
      file,
      message:
        relativeCodeFrameFile && file ? message.replace(relativeCodeFrameFile, file) : message,
    },
  }
}
process.stdout.write(JSON.stringify(result) + '\n')
