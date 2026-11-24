/** Video ingestion and questions through Gemini, regardless of the asking agent's model. */
import { defineApi } from '../../shared/extension-api.ts'
import type { AskArgs, Video } from './refs.ts'
import type { AskResult } from './types.ts'

export type VideoService = {
  /** Copy a local file and queue preparation, or register an immediately ready HTTPS URL. */
  ingest(
    from: { path: string } | { url: string },
    options: { conversation: number; name?: string; source?: Video['source'] },
  ): Promise<Video>
  /** Ask about a ready video, reusing the caller's previous turns for the same range and media settings. */
  ask(args: AskArgs & { conversation: number }, signal: AbortSignal): Promise<AskResult>
}

/** Supply videos and ask questions on behalf of a conversation. */
export const VideoApi = defineApi<VideoService>()('video')
export { VideosDoc, VideoReady, VideoFailed } from './refs.ts'
export type { AskArgs, Video, Videos, Turn } from './refs.ts'
export type { AskResult } from './types.ts'
