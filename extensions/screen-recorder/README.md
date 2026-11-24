Screen recording: a button in every desktop prompt box records the screen and mic into one video and attaches it to that box.

## How it works

- **Start** only from a press: the browser asks which screen, window or tab to share (with its audio where the
  browser offers it), then the microphone. Without a mic the recording keeps the screen and its audio; the badge says
  `screen` instead of `screen + mic`.
- **While recording** every prompt box shows the badge (elapsed time, Cancel, Stop) and a red hairline, so it stays in
  view after a conversation switch. The page does not switch to a new bundle until the recording ends
  (`holdReload` from the SDK). Recordings stop themselves after 30 minutes.
- **Stop** (the badge's square, or the browser's own "Stop sharing") ends it and attaches a `Screen recording <time>.webm`
  to the box the square was pressed in, or for the browser's stop to the draft that started it: the same path as a
  pasted video (`video` uploads it in chunks and shows its chip). When that draft's box is not on screen or busy, the
  recording waits in the page until it is shown again, and the page keeps holding reloads until the upload settles.
  **Cancel** or **Escape** discards it; nothing is uploaded.
- **Mixing:** the shared audio and the mic go through one `AudioContext` into one `MediaRecorder` track:
  `video/webm` with VP9 and Opus on Chromium (VP8 or MP4 where VP9 is missing), about 2.5 Mbit/s.
- **Desktop only:** phones and touch devices show no button; they can still paste or pick a video. It needs a
  secure page (the tailnet URL or localhost).

The button is the provider of the SDK's `PromptRecorder` point, which every `PromptBox` renders, the voice dock's
included: a video attached there goes with the next spoken or typed turn.
