# Security

Ultimate is a local coding agent: it runs model-authored commands with your user's privileges, in your project
directory. Treat it as you would any tool that can edit your files and reach your network.

## Reporting a vulnerability

Report privately, not in a public issue. Where the repository has **Settings → Code security → Private vulnerability
reporting** turned on, its **Security → Advisories → Report a vulnerability** form is the channel; otherwise contact
the maintainer of the clone you are running through whatever private channel they publish. A fork ships with that
feature off, and only its own administrator can turn it on, so this file names the path rather than a URL that would
404 there.

Include what you need to make the problem reproducible: the version or commit, your platform, and the smallest
sequence of steps that shows the issue. A proof of concept in a throwaway project is welcome; do not send secrets,
private repository contents, or anything you are not free to share.

This is a personal project, not a product with a support contract, so there is no response-time commitment. Reports
are read and real issues are fixed.

## Scope

In scope: anything that breaks the trust boundaries this project claims for itself. That means getting the loopback
origin or identity checks to admit a request they should refuse, reaching the API or the agent from a web page on
another origin, escalating from a project extension to something it should not do without the trust decision, or
making the updater apply code the user did not choose.

Out of scope: the agent running shell commands, editing files, or reaching the network. That is the product. A
prompt that talks the model into a destructive command is a prompt-injection case, not a vulnerability in this
codebase — the model is instructed to run what you ask it to run.

## Deploying

The server binds to `127.0.0.1` and expects to stay there. Do not expose an instance to a network you do not
control. For untrusted work, run it in a container, a VM, or a disposable worktree, and review a project's
extensions before accepting its trust prompt; accepting one runs that project's code on your machine.

