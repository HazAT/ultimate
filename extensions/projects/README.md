A project switcher at the window's left edge: Ultimate instances on this machine and configured remote machines, one click away.

## How it works

- **Rail** (`shell.rail`, on desktop and tablet; nothing on a phone): one row per local running instance or configured remote project. It shows while at least two projects are listed. Rows are grouped by machine: **This machine** first, then the configured machine names, preserving project order within each group. Expanded groups have quiet machine labels; collapsed groups are separated by space, keeping the existing project colour swatches.
  - Collapsed, the rail is one quiet column of colour, a swatch per project and no letters (`ProjectSwatch` from the sidebar). Ultimate's own family (`ultimate`, `ultimate-eval`, a branch checkout of it) is the brand purple; every other project takes a muted, cool hue (sage, teal, blue; no warm hues, so nothing reads as amber or red, and no violet, which stays Ultimate's), derived from the folder name alone (`colourOf` in the sidebar's `tile.tsx`, small and exported for other overviews), so a project keeps its colour on every instance and in the sidebar's header. Projects sharing a name stem (`ultimate`, `ultimate-eval`, `ultimate-fleet`) take neighbouring shades of one hue, and their adjacent swatches join into one strip with a gap before the next family. Other projects' swatches are slightly faded until hovered; the one this page shows is wider and full colour, ringed, with a brand bar on the edge. The swatch, its amber count and its working dot share the column's vertical axis.
  - Hovering opens it over the app (272 px); the pin button keeps it open beside the app. Each row then shows the display name (`prettyName`), and under it the GitHub `owner/repo` with a lock when private, and the port. The pin is one value for every instance on this machine (`~/.ultimate/projects-rail.json`), so jumping keeps the rail as it was.
  - For this machine's projects, a loopback page links to the instance's loopback URL. A page opened over the tailnet links to the host the page came from, on that project's Tailscale port (`tailnetPort`, from the registry `~/.ultimate/tailscale.json`), since a loopback address means nothing there. A local project not published on the tailnet shows dimmed, with no link. Remote rows always use their configured URL unchanged, regardless of this page's address; their port is that URL's explicit port, or 80 for HTTP and 443 for HTTPS. A malformed configured URL shows `—` instead of a port without breaking the rail. `links.ts` decides the link and displayed port.
  - A row is a plain link to the instance (its `/` locally, the configured URL remotely), which opens its Ultimate conversation: a click goes there in this tab, mod-click or middle-click opens a new tab, Back returns. The old page stays until the new one paints (seconds while the target builds its web bundle), so a click pulses its swatch, says "opening…" and runs a thin brand bar along the window's top; a page restored by Back clears it.
  - Live state, polled every 4 s while the tab is visible: an amber count of questions waiting for the user, else a pulsing brand dot while an agent works (questions outrank working; the two never show together). Folded, they sit on the swatch: amber is the only warm colour in the column, so a project waiting on you stands out. An instance whose status cannot be read has a neutral marker when collapsed and **unavailable** text when expanded; missing counts are unknown, not idle. Status failure alone does not remove its link. The footer sums the known counts (`1 for you · 2 working`).
- **Another rail wins:** when any other enabled extension fills `shell.rail` (a fleet switcher of your own, say), this one renders nothing and stops polling, so the window never shows two rails.

## Configuration and access

No new configuration is needed. Remote rows use the existing `remotes` setting in `~/.ultimate/settings.json` (user settings only), mapping machine names to project URLs:

```json
{
  "remotes": {
    "laptop": {
      "my-app": "https://laptop.tail1234.ts.net:4747"
    }
  }
}
```

Project settings cannot add remotes. Listing a remote does not publish it or expand permissions: its existing network access and authentication still apply, including `tailscale.allow` for Tailscale Serve. The rail reads status only; it does not grant messaging or other actions any additional access.

## Files

- `server.ts`
  - `list`, `{}` → `RunningProject[]` (`refs.ts`): the projects `host.projects()` finds running (their supervisor lock is held by a live process), each with its loopback URL, followed by entries from user `remotes` in machine/project order, each with its configured URL and `machine` name. A local branch checkout's name is `<project> #<id>`, so it shows and colours with its project. Local rows carry their `origin`'s GitHub `repo` (`{name, url, visibility?}`) once known: read in the background on first sight (`git`, then one `gh repo view`) and kept for the process, so a poll never waits on it. This instance's `busy` and `questions` come from its own conversations and open questions; every other instance's from its `status` action at its loopback or configured remote URL, waiting at most 1.5 s. A failed, slow or invalid status response yields `unavailable: true` without counts; the row stays listed for later polls.
  - `pin`, `{ pinned? }` → `{ pinned }`: the shared pin, written first when `pinned` is given.
- `web.tsx`: the rail and the opening bar.
