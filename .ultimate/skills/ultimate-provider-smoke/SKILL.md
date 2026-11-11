---
name: ultimate-provider-smoke
description: Check a change whose behaviour depends on the provider or model itself (latency, streaming of tool arguments, a pinned agent model, login or fallback, prompt caching) on the models it is meant for, with one short real turn on a preview started with `model: null`. Use when a normal preview cannot show it because it runs every agent on one model; fall back to a supervised scratch server only for restart, core swap or other process-level behaviour.
---

# Smoke-test the real provider

A preview (`instance start`) normally runs every agent on `instance.model` through `ULTIMATE_MODEL`, which overrides
agent pins, the root model and `summaryModel`. Started with `model: null` it sets no `ULTIMATE_MODEL`, so
each agent runs on its configured model and provider (`extensions/instance/README.md`). That covers latency,
streaming, pinned agent models, login or fallback, and prompt caching. Spend one or two short turns.

## Start a preview on the configured models

`instance start` with `model: null` from your workspace; note its URL and home. The argument applies to this preview
only: never edit `~/.ultimate/settings.json` for it, since every other preview started meanwhile would read the change.

To try a different model, set it the way a user would: an agent definition or a project setting in the checkout,
or the composer's model picker in the preview. Logins are read from `~/.pi/agent` and Claude Code's own login, never
copied; do not copy `auth.json`, credentials or secrets anywhere.

## Only when the test needs the process: a scratch server

A preview has no supervisor, so it cannot restart. For restart, a core swap or other process-level behaviour, run
the scratch server from `docs/running.md` in the background instead, from the branch's worktree:

```bash
H=$(mktemp -d /tmp/ultimate-smoke-XXXX)
env $(env | grep -o '^ULTIMATE_[A-Z_]*' | sed 's/^/-u /') ULTIMATE_HOME=$H ULTIMATE_USER_HOME=$H/user \
  pnpm start --port 4799 --no-open > $H.log 2>&1 &
echo "supervisor pid $!"
```

Unsetting every inherited `ULTIMATE_*` drops the live server's home and project; the empty user home keeps the real user extensions in `~/.ultimate` out. Wait until `$H.log` says
`supervisor: ready`. Do not set `PI_CLAUDE_CODE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR` to `~/.claude`: Claude Code would
write a stray `~/.claude/.claude.json` beside the real `~/.claude.json`.

## Drive one turn

Screenshot the URL. Its header shows @ultimate's `#<id>` and its composer shows the model. A `send` without
`conversation` goes to the shown conversation; name it anyway:

```json
{"url": "<url>/?conversation=<id>", "steps": [
  {"until": "idle", "conversation": <id>},
  {"send": "Reply with exactly the word: pong. Do not call any tools.", "conversation": <id>},
  {"until": "idle", "conversation": <id>, "timeoutMs": 180000}
], "screenshot": true}
```

Use a prompt that exercises only the behaviour under test: one tool call to watch streaming arguments, or two sends
to see the cache read on the second one.

## Read the evidence

Read the home (`<home>` from `instance start`, or `$H`) read-only, before stopping: stopping a preview deletes its
temporary home.

```bash
# every model call: conversation, provider/model, wall time in ms, usage and stop reason
sqlite3 -readonly <home>/trace.sqlite \
  "select conversation, name, round(ms), result from calls where kind='model' order by at"
# the conversation's model and its usage document (pi.agent, pi.usage)
sqlite3 -readonly <home>/state.sqlite "select d.kind, r.content from documents d
  join document_revisions r on r.document_id = d.id
  where d.owner_id = <id> and d.kind in ('\"pi.agent\"', '\"pi.usage\"') order by r.seq desc"
```

`pi.agent.model` is the model that actually ran. `pi.usage` has its tokens, cache reads and writes, and cost. The
trace also lists background calls such as titles and summaries on `summaryModel`; keep those apart.

## Clean up

- Preview: `instance stop`.
- Scratch server: `kill <supervisor pid>` (not `pkill -f`: the pattern matches your own shell), then
  `rm -rf $H $H.log`.

## Report

State the model that ran, taken from `pi.agent` or the trace, not the configured one. Give the measured numbers: the
model call's milliseconds, its input, output and cache tokens, and the cost. Name what you could not reach as
unverified. Leave out machine names and addresses.
