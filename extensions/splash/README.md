Ultimate opens with a boot screen: the wordmark, what is still loading, and a prompt line you can type into before the
app is ready.

## What it does

- **On a fresh load** a root overlay covers the window until `useReady().ready`: every enabled facet has loaded or
  failed and the first system snapshot is in, or the core's 8 s deadline has passed. The shell holds the app back until
  then, so nothing of it flashes.
- **The screen** is the empty conversation's style: `ULTIMATE` typed in letter by letter with a blinking block cursor,
  then three rows that read real state (`stream` open or connecting, `host` and its generation, `ext` loaded of total).
  A row still waiting pulses; done, it turns to the foreground colour.
- **Type while it boots**: the `›` line has focus as soon as it shows. Once the app has rendered, what was typed moves
  into the shown conversation's composer (after any draft it already held), which takes focus with the cursor at the
  end. Nothing is sent.
- **Gone at ready**: no minimum time. It fades out in 160 ms, and stops taking clicks the moment it starts to.
- **Reduced motion** (`prefers-reduced-motion`): the wordmark and rows show at once, the cursor holds still and the
  overlay goes without a fade.
- **Fresh starts only**: mounted when the page is already ready, on a reload of a rendered page (a core restart, a
  switch to a new web bundle, F5) or in an automated browser (`navigator.webdriver`), it shows nothing.
- **Never stuck**: not ready after 8 s, the core reveals the app anyway, and a small notice names the extensions still
  loading (`useReady().pending`) and those that failed (`useReady().failed`), until they load or it is dismissed.
- **Rehearsal**: `?splash` holds it on screen, automated browsers included.

The overlay is a `progressbar` labelled "Loading Ultimate", `aria-busy` and `aria-live="polite"`; the wordmark and rows
are `aria-hidden`, the prompt line is labelled "Start typing while Ultimate loads".

Turn it off with `{ "extensions": { "disable": ["splash"] } }` in `~/.ultimate/settings.json`.
