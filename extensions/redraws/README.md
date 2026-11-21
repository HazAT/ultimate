Redraws flashes every DOM node the page writes and counts the writes per area, so you can see what a streamed update or a click really changes and measure it when something feels off. Off by default: turn it on with `extensions.enable: ["redraws"]` (the Extensions tab does it), then ⌘K **Show redraws**.

## Why DOM writes

React DevTools highlights components that re-rendered. Solid never re-runs a component; it writes single text nodes, attributes and children. So the equivalent here is the write itself: every flash is a node that changed. Solid's own tooling (owner names, `OBSERVE.records`, performance tracks) exists only in its dev and observe builds, and Ultimate ships the production build, so this extension watches the DOM and needs neither.

## In the UI

- **Flashes:** a fixed overlay over the whole page outlines each written element for 0.8 s. It takes no pointer events and never changes layout. Writes are collected with one `MutationObserver` and painted once per animation frame, one outline per element, so fast streaming stays one box per element per frame.
- **The `redraws` chip** in the status line shows the total since the last reset. Its popover lists the window, writes per area (transcript, composer, status line, header, title bar, sidebar, panel, other), long animation frames (Chromium's `long-animation-frame` entries: frames over 50 ms, with the worst) and the five elements written most, named by their nearest `data-ui` or `aria-label`. **copy** copies the same as text for a report; **Reset redraw counts** starts a new window; **Stop showing redraws** turns it off.
- Its own chip and overlay are left out of the counts.

Nothing runs while it is off: the observers exist only while it shows, and the state is page-local, so a reload turns it off.

## For agents

Toggle it with `{ ui: 'act', steps: [{ ref: 'Show redraws', action: 'run' }] }` (or the palette), do the thing to measure, then open the `Redraws` popover and read its rows with `ui query`, or copy the summary.
