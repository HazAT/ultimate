import { mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Video } from './refs.ts'

export type Runner = (
  command: string,
  args: readonly string[],
  options: { signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>
export type Prepared = { seconds?: number; parts: NonNullable<Video['parts']> }

const MAX_PART_BYTES = 100 * 1024 * 1024
const MAX_PART_SECONDS = 45 * 60
const SEGMENT_SECONDS = MAX_PART_SECONDS - 1
const SCRATCH_PREFIX = '.preparing-'
const localInput = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,webm,avi,mpeg,mpegts,ogg,flv,asf',
]

async function runTool(run: Runner, command: string, args: string[], signal: AbortSignal) {
  try {
    return (await run(command, args, { signal })).stdout
  } catch (error) {
    signal.throwIfAborted()
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') return undefined
    const reason = failure.stderr?.trim().split('\n').slice(-6).join('\n') || String(error)
    throw new Error(`${command}: ${reason}`, { cause: error })
  }
}

export async function prepareVideo(
  run: Runner,
  dir: string,
  source: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<Prepared> {
  const input = join(dir, source)
  for (const name of await readdir(dir)) {
    if (name.startsWith(SCRATCH_PREFIX)) await rm(join(dir, name), { recursive: true, force: true })
  }
  const temp = await mkdtemp(join(dir, SCRATCH_PREFIX))
  try {
    const probe = await runTool(
      run,
      'ffprobe',
      [
        '-v',
        'error',
        ...localInput,
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
      ],
      signal,
    )
    const duration = Number(probe?.trim())
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : undefined
    const manifest = join(temp, 'parts.csv')
    const transcoded =
      probe === undefined
        ? undefined
        : await runTool(
            run,
            'ffmpeg',
            [
              '-nostdin',
              '-loglevel',
              'error',
              ...localInput,
              '-i',
              input,
              '-map',
              '0:V:0',
              '-map',
              '0:a:0?',
              '-map_metadata',
              '-1',
              '-vf',
              'scale=w=-2:h=min(720\\,max(2\\,trunc(ih/2)*2)),fps=5',
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              '-bf',
              '0',
              '-crf',
              '30',
              '-c:a',
              'aac',
              '-force_key_frames',
              `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
              '-f',
              'segment',
              '-segment_time',
              String(SEGMENT_SECONDS),
              '-reset_timestamps',
              '1',
              '-segment_format_options',
              'movflags=+faststart',
              '-segment_list',
              manifest,
              '-segment_list_type',
              'csv',
              join(temp, 'part-%03d.mp4'),
            ],
            signal,
          )
    if (transcoded === undefined) {
      const bytes = (await stat(input)).size
      const limit =
        bytes > MAX_PART_BYTES
          ? '100 MB'
          : seconds !== undefined && seconds > MAX_PART_SECONDS
            ? '45 minutes'
            : undefined
      if (limit)
        throw new Error(
          `Install ffmpeg (e.g. "sudo pacman -S ffmpeg", "brew install ffmpeg" or "apt install ffmpeg") to send videos over ${limit}`,
        )
      return {
        ...(seconds === undefined ? {} : { seconds }),
        parts: [{ file: source, mimeType, bytes, ...(seconds === undefined ? {} : { seconds }) }],
      }
    }

    const parts: Prepared['parts'] = []
    let end = 0
    for (const line of (await readFile(manifest, 'utf8')).trim().split('\n')) {
      const segment = /^(part-\d+\.mp4),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(line)
      if (!segment) throw new Error('ffmpeg did not record a video part')
      const [, file, start, until] = segment
      const length = Number(until) - Number(start)
      if (length <= 0 || length > MAX_PART_SECONDS)
        throw new Error(`${file} must be at most 45 minutes`)
      const bytes = (await stat(join(temp, file))).size
      if (bytes > MAX_PART_BYTES) throw new Error(`${file} is over 100 MB`)
      parts.push({ file: `parts/${file}`, mimeType: 'video/mp4', seconds: length, bytes })
      end = Number(until)
    }
    await rm(manifest)
    signal.throwIfAborted()
    await rm(join(dir, 'parts'), { recursive: true, force: true })
    await rename(temp, join(dir, 'parts'))
    return { seconds: seconds ?? end, parts }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
