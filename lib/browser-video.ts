export const browserVideoId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type BrowserClip = { id: string; title: string }

export function browserVideoOf(value: unknown): BrowserClip | undefined {
  if (!value || typeof value !== 'object' || !('video' in value)) return undefined
  const { video } = value
  if (
    video &&
    typeof video === 'object' &&
    'id' in video &&
    typeof video.id === 'string' &&
    browserVideoId.test(video.id) &&
    'title' in video &&
    typeof video.title === 'string'
  )
    return { id: video.id, title: video.title }
  return undefined
}
