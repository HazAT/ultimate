While you scroll up through a long answer, a line at the top of the transcript names the message of yours that it answers; a click scrolls back to it.

## Behaviour

- The line shows the first phrase of your message, cut with an ellipsis when it goes on. A `/skill` input shows its
  request, or the skill's name when it has none. A message you sent through `message` (a `board.message` from you)
  counts as your turn too.
- It shows only while the transcript does not follow its newest row, and hides when the start of that message is on
  screen.
- When your message is older than the rows the transcript has loaded, the line says `finding your message…` and the
  `turn` action reads it from the stored history: one request, without the rows between. A click then loads the
  history down to it and scrolls there, through the core `ultimate:reveal-entry` event.
- A branch's history before its fork point is its source's: the lookup stops there, as the transcript does.

## Pieces

- `web.tsx` renders the line in the `transcript.top` slot and reads the transcript with `useTranscript()` and
  `useTranscriptScroll()`.
- `server.ts` has the `turn` action (`refs.ts`: `{ conversation, before }` → `{ turn? }`); it scans the stored
  history newest first and returns the first turn of yours, never the entries between. It is a poll action: the
  trace counts its calls without writing them.
- `turn.ts` decides what a turn of yours is and its phrase, for both sides.

## Turn it off

It is on by default. Add it to `extensions.disable` in `~/.ultimate/settings.json` (this machine) or
`<project>/.ultimate/settings.json` (one project):

```json
{ "extensions": { "disable": ["sticky-prompt"] } }
```
