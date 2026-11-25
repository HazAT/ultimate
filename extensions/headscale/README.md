Publishes this server on a self-hosted tailnet (Headscale or any control server without HTTPS certificates): a plain HTTP
listener on the node's own mesh address, WireGuard-encrypted, admitting nodes you pick. It offers the same `tailscale`
service as the built-in `tailscale` extension's, over the mesh instead of Serve, so cross-node project links, preview
addresses and setup keep working; enable this one instead of `tailscale`, never both. Off by default; turn it on in user
settings (`"extensions": { "enable": ["headscale"] }`).

## Settings

`~/.ultimate/settings.json`, under `headscale`:

```json
{
  "headscale": { "allow": ["node.tail.example.com", "100.64.0.2"] }
}
```

- **allow**: node DNS names, host names, or mesh addresses. A host name matches every node that carries it, so prefer
  DNS names or addresses on a tailnet with repeated names. Omitted: only this node itself may connect.
- **bind**: the address to listen on, one address of this node (default: its first IPv4 mesh address, never `0.0.0.0`).

The status line's `tailnet` indicator opens a popover with the URL as a QR code, the nodes of the tailnet as a picker,
and a connect hint showing both the MagicDNS URL and the mesh-address URL. Toggling a node writes `headscale.allow`
and reloads the listener at once, cutting off revoked nodes with their open streams; the write goes through only from
this machine's own browser — the mesh listener itself refuses to forward it, so a node already admitted can never
admit another.

## How it admits

The listener binds the node's mesh address and proxies admitted requests to the loopback-only supervisor, so Ultimate
itself never leaves loopback. Each connection's WireGuard source address is mapped to a node through
`tailscale status --json` (cached 30 s; an address the cached map does not know forces a single re-read, so a node
that just joined connects without a wait); a connection from loopback counts as this node. The peer's DNS name, host
name, or mesh address must match the allowlist. Admitted requests reach the supervisor with identity headers the
listener builds itself (`tailscale-user-login`, `x-forwarded-for`); any forwarding headers a client sent are discarded
first, and the supervisor's full admission rules (registered origin, Origin checks, fetch-metadata rules, admission
recheck) apply to every request. Both origins — the MagicDNS name and the mesh address — are registered, so either URL
form works even where MagicDNS does not resolve.

Plain HTTP over WireGuard is encrypted but not a secure context outside localhost: the browser withholds service
workers, camera and microphone (voice input), and the installable home-screen app. For those, terminate HTTPS in
front of Ultimate (a reverse proxy with a certificate for a name that resolves to the node) and leave this extension
off.

## Ports

`~/.ultimate/tailscale.json` (the same format the built-in `tailscale` extension uses) stores the stable port per
project: a new project prefers its local supervisor port if free, otherwise the next free port from 4747. Previews and
scratch servers claim their port under their own home, marked `temporary`, and free it when they stop; a dead owner's
entry is recovered at the next start. `TAILSCALE_COMMAND` names another CLI.

A core swap briefly overlaps two generations of the same project: the dying one releases its registry entry and
port moments after the successor starts, so a port that looks taken at first sight is usually that handoff in
progress. The successor waits it out (up to 10 s, `ULTIMATE_HEADSCALE_HANDOFF_MS` overrides the window) and reports
`port-conflict` only for a holder that outlives it.

## Status action

`POST /api/extensions/headscale/actions/status` with `{ "args": null }` returns
`{ result: { state, url?, meshUrl?, allow: string[], hint? } }`; `retry` starts again unless already ready, `peers`
lists the tailnet's nodes with their allow state, and `allow` (loopback browser only) rewrites the allowlist.
States: `disabled`, `starting`, `ready`, `not-installed`, `not-running`, `port-conflict`, `error`.
