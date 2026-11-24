# Video

Ask Gemini questions about a video from any agent, regardless of its own model. Questions require the optional
Antigravity extension to be enabled (⌘K → Extensions) and signed in with `agy`. Uploads and preparation work
without it. The default model is `gemini-4-neon-low`. Video costs about 105 tokens per second. Follow-ups with the
same options replay the earlier questions and answers so Google can reuse the unchanged video prefix.

## Document and events

`VideosDoc` (`video.videos`) lives on `ROOT_CONVERSATION_ID`. It contains `{ videos: Record<string, Video>,
threads: Record<string, Turn[]> }`. A `Turn` is `{ question, answer }`. Each thread key is the video id, a colon,
and `JSON.stringify([conversation, from, to, fps, detail])`, with absent options serialized as `null`. A different
conversation or media option starts a separate thread.

A `Video` contains `id` (`v_` plus random hex), `name`, `mimeType`, `bytes`, `source` (`paste`, `drop`, `recording`,
`file`, or `url`), the supplying `conversation`, `createdAt` (Unix milliseconds), and `state` (`receiving`,
`preparing`, `ready`, `failed`, or `removing`). It can also contain `url`, `seconds`, `error`, and `parts`. While
preparing, it includes the numeric task ID in `task`. Each part has a `mimeType`, and optionally `file` (relative
to the video folder), `seconds`, and `bytes`. URL videos report zero local bytes and have one `video/mp4` part
without a file. Duration and range arguments are in seconds.

`VideoReady` (`video.ready`, `{ id }`) and `VideoFailed` (`video.failed`, `{ id, error }`) commit with the state change.
`video.failed` rules out `video.ready` for a waiter; both events and the document ref are exported by `api.ts`.

## Actions

| Action   | Arguments                                             | Result                                                                                                                                                                   |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin`  | `{ name, mimeType, bytes, source? }`                  | `{ id }`. Reserves a receiving upload for the caller. MIME must be `video/*`; max 1 GiB. Source defaults to `file`.                                                      |
| `append` | `{ id, offset, data }`                                | `{ received }`. Positional write of at most 8 MiB of base64-decoded data. Retry at the same offset; gaps and writes past the declared size fail.                         |
| `finish` | `{ id }`                                              | `Video`. Queues durable preparation only when the source has exactly the declared bytes. Already preparing or ready videos are returned unchanged.                       |
| `addUrl` | `{ url, name? }`                                      | `Video`. Registers an HTTPS URL as ready without downloading it on the host. Gemini handles YouTube and other URLs it can read.                                          |
| `ask`    | `{ id, question, model?, from?, to?, detail?, fps? }` | `{ answer, usage, model }`. Requires a ready video.                                                                                                                      |
| `remove` | `{ id }`                                              | `null`. Queues removal and waits for it, or returns if removal is already queued. The task stops preparation, deletes local files, then drops the video and its threads. |

The `video_ask` tool takes the same arguments as `ask` and adds a usage line to its answer. Use a bare model id or
`antigravity/<id>`. `from` and `to` select a time range; `fps` changes sampling and `detail` is `low` or `high`.
For a split video, the extension asks overlapping parts separately with offsets local to each part, labels
answers by time range, and sums Google's usage counts. Usage keeps Gemini's names: `promptTokenCount`,
`candidatesTokenCount`, `totalTokenCount`, and `cachedContentTokenCount` or `thoughtsTokenCount` when reported.
The thread changes only after a successful answer. On HTTP 429, wait or retry with a shorter range or lower fps.

## Server API and storage

`host.need(VideoApi)` exposes `ingest({ path } | { url }, { conversation, name?, source? }) → Promise<Video>` and
`ask({ ...args, conversation }, signal) → Promise<AskResult>`. Local paths use recognized video filename
extensions; they are copied into storage and queued for preparation. A URL is ready immediately.

Uploads live under `<host.home>/videos/<id>/`, never in the checkout. Preparation uses `ffprobe` and `ffmpeg` for
standalone video containers such as MP4, MOV, and WebM. It produces H.264/AAC MP4 parts at most 720 pixels tall,
5 frames per second, 45 minutes, and 100 MiB each. If either program is absent, files up to 100 MiB are used
as-is, but a duration longer than 45 minutes requires ffmpeg if `ffprobe` could measure it. Without `ffprobe`,
no duration can be measured and only the 100 MiB cap applies. Preparation and removal resume after a restart.
When the host opens, it queues removal for videos older than 30 days and deletes orphan folders older than 30 days.
If file deletion fails, the video stays listed as `failed` and removal can be retried.
