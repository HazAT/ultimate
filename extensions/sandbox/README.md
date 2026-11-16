Runs the bash, read, write and edit tools of sandboxed agents (workers, by default) inside a bubblewrap sandbox that sees only their own worktree.

Off by default: enable it with `{ "extensions": { "enable": ["sandbox"] } }` in `~/.ultimate/settings.json` or the
project's `.ultimate/settings.json`. It needs Linux, [bubblewrap](https://github.com/containers/bubblewrap) and
unprivileged user namespaces.

## Which agents

A conversation is sandboxed when the agent definition it was started from (the `definition` of its
`ultimate.agent-profile` document, never its label) names a role in the settings. Without `sandbox.roles`, the one role
is `worker`. A sandboxed agent needs its own worktree (`isolate: worktree`); without a ready one its tools refuse.

```json
{
  "sandbox": {
    "roles": {
      "worker": { "network": ["registry.npmjs.org"] },
      "reviewer": { "tools": ["bash", "read", "message"] }
    }
  }
}
```

- `network`: hosts the role may reach, `host` (port 443) or `host:port`, exact names only. Default: none.
- `tools`: the only tools the role may call (`beforeTool` blocks the rest). Default: bash, read, write, edit, message,
  note, memory, plan and workspace. Never list `codemode`: its nested calls bypass tool hooks. Tools that run on the
  host (`web_search`, `web_fetch`, `browser`, `screenshot`, `automation`, `subagent`, `instance`, `restart`) stay
  outside the sandbox and its network allowlist, so they are not in the default list; adding `web_fetch` lets the role
  reach any public URL.

## What a bash call sees

Each call runs `bwrap` with `--die-with-parent --new-session --unshare-user --unshare-pid --unshare-ipc --unshare-uts
--unshare-net --cap-drop ALL --disable-userns` on an empty root (`--tmpfs /`, fresh `/proc`, `/dev` and `/tmp`), so
nothing it starts outlives the call. Paths are the same inside and out:

- read-only: `/usr` (and the `/bin`, `/sbin`, `/lib`, `/lib64` links into it), a few `/etc` files (certificates,
  resolver, passwd, group, locale), the `bin` and `lib` folders of the Node install that runs Ultimate (a Node
  installed under a prefix that holds the home folder, such as `/home` or `/`, is refused);
- read-write: the worktree, except its `.git` pointer file, which is mounted read-only on top; a private `HOME` and
  `TMPDIR` under `<home>/sandbox/<conversation>/`, kept across calls. `HOME` holds a `.gitconfig` with the host's
  `user.name` and `user.email` only.

The environment is cleared: `PATH`, `HOME`, `TMPDIR`, `LANG`, the Git hooks and commit log of `coding-tools`, and the
proxy variables below. Host secrets, sockets (Docker, D-Bus, the SSH agent), other projects and processes, and
`~/.ultimate` do not exist inside. The worktree's `.ultimate/` is writable like any other file; the host never loads a
worktree's copy, and landing review is the gate to the project checkout.

## Git: a shadow common directory

Git inside the sandbox writes only to private copies, so it can move nothing but the workspace branch and replace no
stored object. Inside, the repository's common `.git` is a tmpfs holding:

- `config`: a read-only copy of the real one without its `remote`, `credential`, `url` and `http` sections, so
  tokens in remote URLs stay outside; `HEAD`: a read-only copy; `hooks` and `info`: the real ones, read-only;
- `packed-refs`: the real refs, copied in at the start of every call;
- `objects`: a private store whose alternates point at the real objects, mounted read-only;
  `objects/info` is read-only;
- `refs` and `logs`: private;
- `worktrees/<name>`: a private copy of the worktree's own Git state (`HEAD`, index, logs, refs), seeded from the real
  one whenever the host moved the branch; then `refs` and `logs` start over too, recreated rather than written
  through, so a link the agent planted there never redirects a host write.

After every call the host fetches only the workspace branch back (`git fetch` with `fetch.fsckObjects`, which hashes
every new object and refuses collisions) and, when its tip moved, resets the real worktree's index to it, in the
workspace source's write queue (`WorkspacesApi.serialize`). The bash calls of one conversation run one at a time.
`coding-tools` reads the commit log a sandboxed call wrote, so it keeps only lines naming the call's own repository
(found by the host) and full object ids. A fetch that fails is reported at the end of the call's output; the real
repository keeps its last good tip. Stashes and other refs stay in the shadow. The shadow lives in
`<home>/sandbox/<conversation>/git`; leftovers of conversations without a workspace are removed when the extension
opens.

## Network

With `network`, an in-process HTTPS `CONNECT` proxy for that allowlist listens on a Unix socket in
`<home>/sandbox/`, one per distinct allowlist, closed when the extension closes. It resolves a listed name itself and
refuses loopback, private and link-local addresses, so DNS cannot point it at a host-local service; list an IP to
reach one on purpose. The socket is mounted into the
sandbox, where `bridge.cjs` listens on `127.0.0.1:3128` and forwards to it; `HTTPS_PROXY`, `HTTP_PROXY` and
`NODE_USE_ENV_PROXY=1` point programs at it. Other hosts get `403`; DNS and direct connections fail. A restart kills
running sandboxes with the host (`--die-with-parent`) and the proxy with it; the next call starts it again.

## File tools

`read`, `write` and `edit` run in Ultimate's process, so they get the same policy as the mounts: reads in the
worktree, the private `HOME` and `TMPDIR`, `/usr` and the Node install; writes in the worktree (not its `.git` pointer),
`HOME` and `TMPDIR`. The full-output file of a long bash call is written on the host, outside this policy, so the
agent sees only the retained tail. Paths are resolved through every link first; a link to nothing is refused. A file operation never
runs while a bash call of the same conversation does, so no sandboxed process can swap a link between check and use.

## Worktree setup

`workspaces` asks this extension through its `workspaces.confinement` point. A preserved checkout (a branch with the
agent's own unlanded commits) runs `isolates.worktree.setup` inside the sandbox, with the role's network; a fresh
checkout is its owner's tip and runs on the host as before. A confined setup sees only the checkout: the source
checkout (`ULTIMATE_SOURCE`) is not mounted, and a package install needs the registry in `network`. A setup that
copies files from the source fails there. `subagent land` refuses a sandboxed child whose source is
the project checkout: its commits get there only through `workspace submit`.

## When bubblewrap cannot run

Every sandboxed tool call fails closed with:

> Sandbox unavailable: <reason>. Install bubblewrap and allow it user namespaces: on Ubuntu 24.04+ add
> /etc/apparmor.d/bwrap containing "abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap
> flags=(unconfined) { userns, }" and run sudo apparmor_parser -r /etc/apparmor.d/bwrap; in a Proxmox CT also set
> nesting=1. bash, read, write and edit stay blocked for this agent until then.

The check runs `bwrap` with the same namespace flags once per process and again after every failure.

## Licence

`layout.ts`, `proxy.ts` and `bridge.cjs` port Paperclip's `packages/adapter-utils/src/local-process-sandbox.ts`
(MIT, Copyright (c) 2025 Paperclip AI); see `LICENSE.paperclip`.
