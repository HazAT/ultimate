# Security policy

## Reporting a vulnerability

Report through GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this
repository. Do not open a public issue for a suspected vulnerability.

Include what you know: the affected area (`server/request-security.ts`, a specific extension, the web
UI), the commit you tested, a reproduction and, if you have one, an impact sketch. A proof that needs
no special access is worth more than a long theory.

Reports are triaged as they land. You get an answer before anything is published; fixes land on
`main` like any other change, and credit is yours to claim or decline.

## Scope

Ultimate runs on your machine: the server binds loopback only, and the UI is meant for the operator
using it. The optional `tailscale` extension serves it over the tailnet, to the logins it allows. In
scope is anything that lets a web page, a remote server or a repository break that boundary —

- a request admitted that `server/request-security.ts` should refuse: a cross-site write, a
  cross-origin read, a frame the header policy does not name;
- the agent's tools or extensions reading or sending data past a limit their code enforces;
- a page in the UI acting as another conversation or project (`?conversation=`, previews,
  `window.ultimate`);
- secret material (provider keys, tokens, conversation contents) ending up somewhere the operator did
  not put it;
- a tailnet request admitted for a login the `tailscale` allowlist does not name;
- a project's `.ultimate/` extensions, agents, skills or settings taking effect before the operator
  trusts that project.

Out of scope:

- a hostile process already running on the machine, or an extension the operator chose to install;
- the browser sandbox disabled with `ULTIMATE_CHROMIUM_SANDBOX=0` — the knob exists for environments
  where sandboxing cannot start, and turning it off there is the operator's call;
- attacks that require the operator to hand over access: a prompt they paste, a link they accept;
- content an agent reads (a web page, a file, a tool result) steering what it does, unless it gets
  past a boundary enforced in code: project trust, the request and header policy, the Tailscale
  allowlist.

## Supported

Security fixes land on `main`; run the current `main` to get them.
