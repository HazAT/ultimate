Reel: plays the screenshots a branch and its subagents took as a short full-screen slideshow, beside the question it asks you.

## How it works

- **Where.** A **Reel · N frames** chip sits on every reply-expected message a branch sends you (its card, and the
  Inbox's reading pane) and on each landing card. It shows only with at least two frames.
- **Which screenshots.** The `frames` action (`{ conversation, message? }`) reads the image blocks of tool results
  (`screenshot`, `browser`, any tool that returns an image) in the branch and every conversation it owns, down the
  tree. For a message, the window runs from the branch's previous reply-expected message to you up to this one; for a
  landing, the whole branch. Frames go in entry order, which is shared across conversations, so a designer's shots
  sit between its coordinator's. Identical images in a row collapse into one frame marked ×N; similar ones stay.
  The newest 40 are kept, and the chip says how many earlier ones were left out.
- **Labels.** Each frame names the agent that took it and the step, taken from the call's own arguments (its URL,
  selector, width, theme or its last browser step). Agents add nothing for the reel.
- **The player.** Full screen, autoplaying with a short crossfade; tap or click the left or right third to step, the
  middle to pause; swipe on a phone; ←/→ and Space on a keyboard; a filmstrip below to jump. The speed (1×, 2×, 0.5×)
  is remembered. On the last frame of a message's reel, its question card appears so you can answer without leaving.
- **Nothing is stored.** The list is computed on each read and the images come from the transcripts one entry at a
  time through the history API, the next two preloaded; the page keeps the last 60 in memory. Screenshots taken inside
  codemode scripts are not tool-result images, so they are not in the reel.
