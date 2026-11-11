---
name: ultimate-landing-smoke
description: Check the running Ultimate host after a landing card arrives, before reporting the landing as live: the clone is on the landed sha and clean, a restart happens only when the landing needs one and after warning preview owners, the host is healthy afterwards, and one read proves the landed behaviour. Use after every landing on this repository, by @ultimate or any agent reporting one.
---

# Smoke-check a landing

The landing card says what was merged; it does not prove the host runs it. Read it back, then report only what you
read back (memory `verify-cross-project-status`): the sha, the errors, the models, the proof.

## Steps

1. **Clone:** the host clone is on the card's sha and clean (`git log --oneline -1`, `git status --short`).
2. **Restart only when needed:** the landing changed `server/`, `shared/`, `patches/` or `pnpm-lock.yaml`
   (`git diff --stat <before>..<sha> -- server shared patches pnpm-lock.yaml`). `web/`, `extensions/`, `agents/`,
   skills and docs reload on their own. Before restarting, list running previews and busy branches: a restart stops
   every preview. Tell each preview's owner (`note` its `conversationId`) before calling `restart`.
3. **Health, after any restart:** the build generation went up and left no facet out, no extension has a load
   error, Claude Code is logged in with its models, and your own model in `pi.agent` is the one you expect.
4. **Feature proof:** one read that shows the landed behaviour itself: the file on main, a document, an action's
   result, the served bundle, a screenshot. Never the card's word alone.

## One snippet

Run it in codemode; it returns steps 1 to 3 as one small object. Add the feature proof by hand.

```js
const sh = async (command) => (await tools.bash({ command })).trim()
const clone = await sh(
  'cd /home/haza/Projects/ultimate && git log --oneline -1 && git status --short',
)
const claudeCode = JSON.parse(
  await sh(
    `curl -s http://127.0.0.1:4747/api/models | jq -c '{configured: (.providers[] | select(.id=="claude-code") | .status.configured), models: [.models[] | select(.provider=="claude-code")] | length}'`,
  ),
)
const sys = await ultimate.system()
const ext = await ultimate.extensions()
const previews = (await ultimate.action('instance', 'list')).filter((i) => i.running)
const busy = (await ultimate.conversations()).filter((c) => c.busy && !c.concluded)
return {
  clone,
  build: {
    generation: sys.build.generation,
    at: sys.build.at,
    error: sys.build.error,
    left: sys.build.left,
  },
  extensionErrors: ext.filter((e) => e.server?.error).map((e) => `${e.name}: ${e.server.error}`),
  claudeCode,
  model: (await ultimate.doc('pi.agent')).model,
  previews: previews.map((i) => `${i.url} #${i.conversationId}`),
  busy: busy.map((c) => `#${c.id} ${c.title ?? ''}`),
}
```

Use the host's clone path and UI port from your environment. `/api/models` is large; keep it in `jq`, out of your
context. Run the snippet before a restart (previews and busy branches) and again after it (build and health).

## Report

The landed sha, whether it restarted and why, the health line (`generation`, extension errors, Claude Code models,
own model), the feature proof, and anything unverified named as such.
