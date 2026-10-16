Expose Ultimate over Tailscale HTTPS, admitting only explicitly allowed Tailscale logins. This built-in is on by default, manages its own Serve mappings, and never enables Funnel.

## Settings

Exposure is on unless `~/.ultimate/settings.json` turns it off; only that file can set the allowlist:

```json
{
  "extensions": { "disable": ["tailscale"] },
  "tailscale": { "allow": ["you@example.com"] }
}
```

Omit `tailscale.allow` to allow only the machine owner's login (`Self.UserID` → `User.LoginName` in `tailscale status --json`). Project settings can turn exposure off but cannot turn on what your settings disable or change the allowlist; a project enable over your disable produces a notice and stays disabled. Faux servers never expose. Without Tailscale installed the panel shows how to install it, without a notice. Install Tailscale, log in, enable HTTPS certificates in the admin console, and grant operator rights if needed with `sudo tailscale set --operator=$USER`.

## UI

The Tailscale panel (palette: `Tailscale…`) shows the `status` action, read when it opens and again when system info changes: a registered origin, a failure notice, or a reinstall.

- **ready:** the URL with copy and open buttons, who may open it (`allow`), and that it is tailnet-only.
- **Problems** (`not-installed`, `not-running`, `not-operator`, `https-disabled`, `port-conflict`, `error`): a short title and the hint; a command in the hint, such as `sudo tailscale set --operator=$USER`, becomes a chip that copies it. After a fix, **Check again** starts again in place; a settings change or a restart does too.
- **disabled:** a switch that enables `tailscale` in `~/.ultimate/settings.json` through onboarding's `setExtension` action with user scope; it never offers project scope. The panel loads only with the extension, so this state shows when your settings disable it and a project enables it, and on faux servers. **Check again** rereads the user settings.
- **starting:** a quiet spinner.

While ready, the title bar shows `● tailnet`; hover for the URL, click to open the panel.

## Stable ports, handoff, and recovery

`~/.ultimate/tailscale.json` stores `{ "ports": { "<absolute project root>": { "port": 4747, "owner": "<pid>:<random token>" } } }`. A new project prefers its local supervisor port if free, otherwise the next free port from 4747. Port 443, existing Serve mappings, and other registry assignments are excluded. Registry entries remain after shutdown; prune unused entries by hand when their project is not running.

Assignments are written atomically under a pid-owned SQLite lock (automatically released on process death). Waiters allow two minutes for CLI work; a busy-registry hint asks you to wait and retry. Stale sidecar owners are recovered without manual lock deletion. Each generation claims a fresh owner token when it creates or adopts a mapping. Closing a generation removes the mapping only if its token still owns the assignment and Serve still targets that generation's local supervisor URL. Thus a delayed old shutdown cannot remove a successor's mapping or a foreign replacement.

On start, registered mappings to loopback targets are removed only if the owner's pid is dead and the target is not a live Ultimate supervisor (`host.projects()`). Registry assignments are retained and the current project reuses its stable HTTPS port. Live owners are retained even when absent from project supervisor listings (for example previews and standalone development instances). Foreign targets, extra path handlers, and Funnel mappings are never modified. The URL remains stable across restarts even when the local supervisor port changes. Failed teardown is reported without preventing shutdown; startup can recover its stale mapping.

## Security

Serve replaces identity headers itself, so spoofed `Tailscale-User-Login` values never reach Ultimate through Serve. Identity headers are absent for Funnel and tagged devices, which are denied. Shared-device users have their own logins and are excluded unless explicitly allowed.

Requests with forwarding headers are never treated as local, even if a client supplies a loopback Host or Origin. They must match the registered HTTPS authority and any Origin must equal that origin, then pass login verification. A present `Sec-Fetch-Site` must be `same-origin` or `none`, except that `same-site` and `cross-site` may open only the UI root `/` (query permitted) with method `GET`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, and no `Upgrade` header. This exception passes only the fetch-metadata check: the registered host, exact Origin when present, allowed login, and revocation check still apply. Unknown site values remain denied; cross-site or same-site API, SSE, actions, assets, embedded documents, and HMR upgrades remain blocked. Non-browser clients without fetch metadata still require the allowed identity. Admission rechecks registration after async verification, so in-flight requests cannot outlive revocation. These rules cover assets, API, SSE, actions, and HMR. The listener remains loopback-only; exposure and allowlist configuration are user-level machine-owner decisions.

## Status action

`POST /api/extensions/tailscale/actions/status` with `{ "args": null }` returns `{ result: { state, url?: string, allow: string[], hint?: string } }`.

`POST /api/extensions/tailscale/actions/retry` starts again unless ready or shutting down and returns the status it reached; a retry during a start waits for that start instead of running a second.

States: `disabled`, `starting`, `ready`, `not-installed`, `not-running`, `not-operator`, `https-disabled`, `port-conflict`, `error`. `url` exists when ready. `hint` explains failures; `allow` lists effective logins, never credentials. System info publishes registered URLs in `access.origins`. Identity values are not logged.
