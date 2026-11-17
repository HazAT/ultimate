Ultimate opens with its name: the ULTIMATE wordmark draws itself over the whole window while the app loads, and the
app comes up once the page is ready.

## What it does

- **On load** a root overlay covers the window until `useReady().ready`: every enabled facet has loaded or failed and
  the first system snapshot is in, or the core's 8 s deadline has passed. The shell holds the app itself back until
  then, so the overlay draws over the background `web/index.html` paints and nothing of the app flashes, however late
  the splash installs.
- **The show** (Web Animations API and WebGL): lightning draws the name, sweeping across its outline from left to
  right; at the end it bursts from the middle, a ripple with a flash and a spray of arcs that fades into a steady
  electric outline until the overlay goes. The lightning is `electric.tsx`, adapted from React Bits' ElectricLogo on
  `ogl`, its click burst included. Still loading after that, a quiet rule draws out beneath the name.
  Once ready, a drawing still in progress finishes within a quarter second and the overlay fades into the app. It
  stays at least 0.7 s, so a warm start does not flash.
- **First run** (onboarding's `status` action reports `firstRun`): the signature version plays slower and in full,
  with the rule, then the name lifts away as the overlay fades into onboarding's page beneath, which is already open.
  Without the `onboarding` extension there is no first run.
- **Reduced motion** (`prefers-reduced-motion`) or no WebGL2: the solid wordmark, no lightning, then a quick fade.
- **Never stuck**: not ready after 8 s, the core reveals the app anyway, and a small notice names the extensions still
  loading (`useReady().pending`) and those that failed (`useReady().failed`), until they load or it is dismissed.
- **Once per page load**: mounted when the page is already ready (a very warm start), it shows nothing,
  and nothing after ready brings it back.
- **Fresh starts only**: a reload of a rendered page (a core restart, a switch to a new web bundle, F5) shows the previous
  page's view until the app is back (`resumed` from `@/sdk`), so the splash stays away.
- **Rehearsal**: `?splash` holds the splash on screen, automated browsers included, and a click replays it;
  `?splash=first` plays the first run's version. For polishing it on a preview instance.
- **Automated browsers** (`navigator.webdriver`, as in the agent's `browser` and `screenshot` tools): no show, so the
  first frame is the app.

## Input

While it covers, nothing reaches what is beneath, a dialog included. The overlay takes the clicks, even when a modal
dialog sets `pointer-events: none` on the body. It holds focus and takes every key in the window's capture phase, ahead
of a dialog's Escape and of the shell's shortcuts, which start with the app once ready, after the splash. Focus the
app asks for meanwhile, such as the composer's or onboarding's first page's, is remembered and handed back as the
overlay fades, when the app takes input again.

The overlay is a `progressbar` labelled "Loading Ultimate", `aria-busy` and `aria-live="polite"`; the drawing itself
is `aria-hidden`.

## The wordmark

`web.tsx` holds the outlines of ULTIMATE as the header sets it, Inter SemiBold tracked 0.28em, taken from the
display optical size (`opsz` 32, `wght` 600) of the Inter variable font that `@fontsource-variable/inter` ships, with
overlaps removed and kerned by HarfBuzz. Its colours are theme tokens (`brand`, `foreground`), so it follows light and
dark. The lightning traces the same outlines.

Turn it off with `{ "extensions": { "disable": ["splash"] } }` in `~/.ultimate/settings.json`.
