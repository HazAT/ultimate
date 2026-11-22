Reach Ultimate from your phone and other devices over Tailscale (needs Tailscale on this machine). It serves Ultimate over Tailscale HTTPS, admitting only explicitly allowed Tailscale logins. This built-in is off by default, manages its own Serve mappings, and never enables Funnel.

With `tailscale.mode: "mesh"` it skips Serve and binds its own listener on the node's mesh address instead, for self-hosted control servers (Headscale and other setups where Serve cannot hand out HTTPS certificates). Identity comes from the WireGuard source address of each connection, and admission runs by node, not by login.

## Settings

Turn it on with `extensions.enable` like any extension, in user or project settings; only `~/.ultimate/settings.json` can set the allowlist:

```json
{
  "extensions": { "enable": ["tailscale"] },
  "tailscale": { "allow": ["you@example.com"] }
}
```

`tailscale.mode` picks how it publishes: `"serve"` (the default) drives `tailscale serve`, or `"mesh"` binds a plain HTTP listener on the node's mesh address (`tailscale.bind` overrides the address; the port comes from the registry below). Only `~/.ultimate/settings.json` can set the allowlist:

- **Serve mode:** entries are Tailscale logins. Omit `tailscale.allow` to allow only the machine owner's login (`Self.UserID` → `User.LoginName` in `tailscale status --json`); when status lacks it at start, as right after a boot, it is ready with no one allowed and a hint saying so, and a request from the tailnet reads status again until it lists the owner.
- **Mesh mode:** entries match a node's DNS name (`node.tail.example.com`), its host name, or its mesh address (`100.64.0.2`); a host name matches every node that carries it, so prefer DNS names or addresses on a tailnet with repeated names. Omit `tailscale.allow` to allow only this node itself. On a self-hosted control server every node may share one tailnet user, so there is no owner login to fall back on: on a tailnet shared with other people, list the nodes you trust explicitly — the default keeps the machine to itself.

Project settings never change the allowlist. While it is off, previews have no tailnet address, setup reports no Tailscale area, and the status line shows nothing. A preview started by another Ultimate's `instance` tool, or a scratch server on its own `ULTIMATE_HOME`, publishes on a port of its own (below), so the user can open it from their phone, and frees that port when it stops. `TAILSCALE_COMMAND` names another CLI; tests point it at a missing one, so test servers stay off the tailnet. Without Tailscale installed the panel shows how to install it, without a notice. Install Tailscale, log in, enable HTTPS certificates in the admin console, and grant operator rights if needed with `sudo tailscale set --operator=$USER`.

## Mesh mode

The listener binds the node's mesh address (for example `100.64.0.1`; `tailscale.bind` must be one address of this node, never `0.0.0.0`) and proxies admitted requests to the loopback-only supervisor, so the Ultimate server itself never leaves loopback. Each connection's source address is mapped to a node through `tailscale status --json` (`Self` and `Peer.TailscaleIPs`, re-read on an address the last reading does not know); a connection from loopback counts as this node. The peer's DNS name, host name, or mesh address must match `tailscale.allow`.

Admitted requests reach the supervisor with identity headers the listener builds itself (`tailscale-user-login`, `x-forwarded-for`); any forwarding headers a client sent are discarded first, so a peer cannot vouch for another address, and the supervisor's full admission rules (registered origin, Origin checks, fetch-metadata rules, admission recheck) apply to every request exactly as over Serve. Changing `tailscale.allow` closes the listener and its open streams, so a revoked node is cut off at once; clients reconnect.

Plain HTTP over WireGuard is encrypted but not a secure context outside localhost: the browser withholds service workers, camera and microphone (voice input), and the installable home-screen app. For those, terminate HTTPS in front of Ultimate instead: a reverse proxy on this machine with a certificate for a name that resolves to the node, proxying to the loopback supervisor, and Ultimate's listener left in its default loopback-only mode (leave `tailscale` off). Admission is then the proxy's job (its own auth, or the mesh address its upstream connections come from), not Ultimate's.

## UI

The server logs the HTTPS URL when it is registered (`Ultimate: https://… (remote)`) and when it is no longer served, so the terminal and `supervisor.log` show where Ultimate is reachable. The supervisor dashboard keeps the current one at its top, with the localhost URL underneath; disabling the extension removes it from the dashboard.

The status line's `tailnet` indicator opens a popover with the `status` action, read on load and again when system info changes: a registered origin, a failure notice, or a reinstall. The indicator shows a green dot while ready and an amber one while a problem needs a fix; off or starting it stays out of the line, and the palette's `Tailscale…` opens the popover in its place.

- **ready:** the URL as a QR code to scan, with copy and open buttons, who may open it (`allow`), and that it is tailnet-only.
- **Problems** (`not-installed`, `not-running`, `not-operator`, `https-disabled`, `port-conflict`, `error`): a short title and the hint; a command in the hint, such as `sudo tailscale set --operator=$USER`, becomes a chip that copies it. After a fix, **Check again** starts again in place; a settings change or a restart does too. While ready, **Check again** serves the mapping again if something removed it.
- **disabled:** "off", only while the extension shuts down; turn it on in the Extensions tab.
- **starting:** a quiet spinner.

Other extensions read the status through `TailscaleApi` (`api.ts`), `host.want(TailscaleApi)?.status()`; `instance` takes the DNS name of its `url` for its previews' tailnet addresses.

## On your phone's home screen

The web UI installs as a standalone app (`web/public/manifest.webmanifest`, the meta tags in `web/index.html`; no
service worker). On an iPhone in the same tailnet: scan the popover's QR code, open it in Safari, then Share → Add to
Home Screen with Open as Web App on. It opens without Safari's bars, edge to edge under the status bar. Identity comes
from Serve's headers, not cookies or redirects, so nothing sends the app back out to Safari. The icon keeps the URL
with its port: should the registry hand this project another port, add it again.

## Stable ports, handoff, and recovery

`~/.ultimate/tailscale.json` stores `{ "ports": { "<absolute project root>": { "port": 4747, "owner": "<pid>:<random token>" } } }`. A new project prefers its local supervisor port if free, otherwise the next free port from 4747. Port 443, existing Serve mappings, and other registry assignments are excluded. Registry entries remain after shutdown; a dead owner's entry whose folder no longer exists goes at the next start. Only the server on the project's default home (`~/.ultimate/projects/<name>-<hash>`, held by its lock, so one at a time) registers under the project root. Any other home (an `instance` preview, a scratch server on `ULTIMATE_HOME=$(mktemp -d)`) claims its port under that home instead, marked `"temporary": true`, whatever `ULTIMATE_*` variables it inherited, so it never takes or removes the address of the live server of the same folder; its entry goes when it closes, or at the next start once its owner is dead.

Assignments are written atomically under a pid-owned SQLite lock (automatically released on process death). Waiters allow two minutes for CLI work; a busy-registry hint asks you to wait and retry. Stale sidecar owners are recovered without manual lock deletion. Each generation claims a fresh owner token when it creates or adopts a mapping. Closing a generation removes the mapping only if its token still owns the assignment and Serve still targets that generation's local supervisor URL. Thus a delayed old shutdown cannot remove a successor's mapping or a foreign replacement.

On start, registered mappings to loopback targets are removed only if the owner's pid is dead and the target is not a live Ultimate supervisor (`host.projects()`). Registry assignments are retained and the current project reuses its stable HTTPS port. Live owners are retained even when absent from project supervisor listings (for example previews and standalone development instances). Foreign targets, extra path handlers, and Funnel mappings are never modified. The URL remains stable across restarts even when the local supervisor port changes. Failed teardown is reported without preventing shutdown; startup can recover its stale mapping.

## Security

Serve replaces identity headers itself, so spoofed `Tailscale-User-Login` values never reach Ultimate through Serve. Identity headers are absent for Funnel and tagged devices, which are denied. Shared-device users have their own logins and are excluded unless explicitly allowed.

Requests with forwarding headers are never treated as local, even if a client supplies a loopback Host or Origin. They must match the registered HTTPS authority and any Origin must equal that origin, then pass login verification. A present `Sec-Fetch-Site` must be `same-origin` or `none`, except that `same-site` and `cross-site` may open only the UI root `/` (query permitted) with method `GET`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, and no `Upgrade` header. This exception passes only the fetch-metadata check: the registered host, exact Origin when present, allowed login, and revocation check still apply. Unknown site values remain denied; cross-site or same-site API, SSE, actions, assets, embedded documents, and HMR upgrades remain blocked. Non-browser clients without fetch metadata still require the allowed identity. Admission rechecks registration after async verification, so in-flight requests cannot outlive revocation. These rules cover assets, API, SSE, actions, and HMR. The listener remains loopback-only; exposure and allowlist configuration are user-level machine-owner decisions.

## Status action

`POST /api/extensions/tailscale/actions/status` with `{ "args": null }` returns `{ result: { state, url?: string, allow: string[], hint?: string } }`.

`POST /api/extensions/tailscale/actions/retry` starts again unless shutting down and returns the status it reached; a retry during a start waits for that start instead of running a second. Once ready it checks the mapping: while this server's token owns the registration and Serve targets its local URL (or a live successor took over), it does nothing; otherwise it claims the port again.

States: `disabled`, `starting`, `ready`, `not-installed`, `not-running`, `not-operator`, `https-disabled`, `port-conflict`, `error`. `url` exists when ready. `hint` explains failures; `allow` lists effective logins, never credentials. System info publishes registered URLs in `access.origins`. Identity values are not logged.
