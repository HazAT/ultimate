A project switcher at the window's left edge: every Ultimate running on this machine, one click away.

## How it works

- **Rail** (`shell.rail`, on desktop and tablet; nothing on a phone): one tile per running instance, two letters of its project's name, in project order. The project this page shows has the brand colour and a bar on the edge. It shows only while at least two projects run.
  - Hovering opens it over the app with names and ports; **pin** keeps it open beside the app. The pin is one value for every instance on this machine (`~/.ultimate/projects-rail.json`), so jumping keeps the rail as it was.
  - On a page opened over the tailnet a tile goes to the host the page came from, on that project's Tailscale port (`tailnetPort`, from the registry `~/.ultimate/tailscale.json`), since a loopback address means nothing there. A project not published on the tailnet shows dimmed, with no link. `links.ts` decides both from the page's host.
  - A tile is a plain link to the instance's `/`, which opens its @ultimate: a click goes there in this tab, mod-click or middle-click opens a new tab, Back returns. The old page stays until the new one paints (seconds while the target builds its web bundle), so a click marks the tile pulsing with "opening…" and a thin brand bar runs along the window's top; a page restored by Back clears it.
  - Live state, polled every 4 s while the tab is visible: a pulsing brand dot while an agent works, a yellow count of questions waiting for the user. The footer sums it up (`1 for you · 2 working`).
- **Another rail wins:** when any other enabled extension fills `shell.rail` (a fleet switcher of your own, say), this one renders nothing and stops polling, so the window never shows two rails.

## Files

- `server.ts`
  - `list`, `{}` → `RunningProject[]` (`refs.ts`): the projects `host.projects()` finds running (their supervisor lock is held by a live process), each with its loopback URL. This instance's `busy` and `questions` come from its own conversations and open questions; every other instance's from its `status` action over loopback, waiting at most 1.5 s. One that does not answer in time is listed without them.
  - `pin`, `{ pinned? }` → `{ pinned }`: the shared pin, written first when `pinned` is given.
- `web.tsx`: the rail and the opening bar.
