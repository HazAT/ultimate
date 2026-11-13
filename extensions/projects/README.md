A project switcher at the window's left edge: every Ultimate running on this machine, one click away.

## How it works

- **Rail** (`shell.rail`, on desktop and tablet; nothing on a phone): one row per running instance, in project order. It shows only while at least two projects run.
  - Each project leads with its tile (`ProjectTile` from the sidebar): its monogram on a hue derived from its folder name, the same on every instance and in the sidebar's header, so a project keeps its colour wherever you see it. Other projects' tiles are muted until hovered; the one this page shows is full colour with a brand bar on the edge.
  - Hovering opens it over the app (272 px); the pin button keeps it open beside the app. Each row then shows the display name (`prettyName`), and under it the GitHub `owner/repo` with a lock when private, and the port. The pin is one value for every instance on this machine (`~/.ultimate/projects-rail.json`), so jumping keeps the rail as it was.
  - A row is a plain link to the instance's `/`, which opens its @ultimate: a click goes there in this tab, mod-click or middle-click opens a new tab, Back returns. The old page stays until the new one paints (seconds while the target builds its web bundle), so a click pulses the tile, says "opening…" and runs a thin brand bar along the window's top; a page restored by Back clears it.
  - Live state, polled every 4 s while the tab is visible: an amber count of questions waiting for the user, else a pulsing brand dot while an agent works (questions outrank working; the two never show together). Folded, they sit on the tile's corners. The footer sums it up (`1 for you · 2 working`).
- **Another rail wins:** when any other enabled extension fills `shell.rail` (a fleet switcher of your own, say), this one renders nothing and stops polling, so the window never shows two rails.

## Files

- `server.ts`
  - `list`, `{}` → `RunningProject[]` (`refs.ts`): the projects `host.projects()` finds running (their supervisor lock is held by a live process), each with its loopback URL. Each carries its `origin`'s GitHub `repo` (`{name, url, visibility?}`) once known: read in the background on first sight (`git`, then one `gh repo view`) and kept for the process, so a poll never waits on it. This instance's `busy` and `questions` come from its own conversations and open questions; every other instance's from its `status` action over loopback, waiting at most 1.5 s. One that does not answer in time is listed without them.
  - `pin`, `{ pinned? }` → `{ pinned }`: the shared pin, written first when `pinned` is given.
- `web.tsx`: the rail and the opening bar.
