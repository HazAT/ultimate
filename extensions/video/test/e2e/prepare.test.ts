import { join } from 'node:path'
import { expect, it } from 'vitest'
import { execFile } from '../../../../lib/spawn.ts'
import { fixture } from '../fixture.ts'

const ffmpeg = await execFile('ffmpeg', ['-version']).then(
  () => true,
  (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  },
)

it.skipIf(!ffmpeg)('prepares a real 960p 30 fps video with audio as a smaller MP4', async () => {
  const f = await fixture(execFile)
  const source = join(f.home, 'testsrc.mp4')
  await execFile('ffmpeg', [
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1280x960:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2.4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-c:a',
    'aac',
    source,
  ])
  const { id, state } = await f.service.ingest({ path: source }, { conversation: 1 })
  expect(state).toBe('preparing')
  const video = await f.prepared(id)
  expect(video).toMatchObject({ state: 'ready', seconds: 2.4 })
  expect(video?.parts).toHaveLength(1)
  const part = video!.parts![0]
  const { stdout } = await execFile('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,height,avg_frame_rate',
    '-of',
    'json',
    join(f.home, 'videos', id, part.file!),
  ])
  const { streams } = JSON.parse(stdout) as {
    streams: { codec_name: string; height?: number; avg_frame_rate: string }[]
  }
  const picture = streams.find((stream) => stream.codec_name === 'h264')!
  expect(picture.height).toBeLessThanOrEqual(720)
  const [numerator, denominator] = picture.avg_frame_rate.split('/').map(Number)
  expect(numerator / denominator).toBeLessThanOrEqual(5)
  expect(streams.some((stream) => stream.codec_name === 'aac')).toBe(true)
})
