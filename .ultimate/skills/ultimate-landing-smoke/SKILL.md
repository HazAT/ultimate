---
name: ultimate-landing-smoke
description: 'Check the running Ultimate host after a landing card arrives, before reporting the landing as live: the clone is on the landed sha and clean, the host restarted when the card says `needs restart` and is healthy afterwards, and one read proves the landed behaviour. Use after every landing on this repository, by @ultimate or any agent reporting one.'
---

# Smoke-check a landing

The landing card is one line, `#<id> <title> landed as <sha> on main · pushed · needs restart`, then its divergence. It
says what was merged; it does not prove the host runs it. Read it back, then report only what you
read back (memory `verify-cross-project-status`): the sha, the errors, the models, the proof.

## Steps

1. **Clone:** the host clone is on the card's sha and clean (`git log --oneline -1`, `git status --short`).
2. **Restart:** only a card with `needs restart` needs one, and @ultimate calls the `restart` tool for it as its
   prompt says; everything else reloads on its own. Another agent reports a missing restart rather than restarting.
3. **Health, after any restart:** the build generation went up and left no facet out, no extension has a load
   error, Claude Code is logged in with its models, and your own model in `pi.agent` is the one you expect.
4. **Feature proof:** one read that shows the landed behaviour itself: the file on main, a document, an action's
   result, the served bundle, a screenshot. Never the card's word alone.

## One snippet

Run it in codemode after any restart; it returns steps 1 and 3 as one small object. Add the feature proof by hand.

```js
const sh = async (command) => {
  const { output, exitCode } = await tools.bash({ command })
  if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}: ${output}`)
  return output.trim()
}
const sys = await ultimate.system()
const clone = await sh(`cd ${sys.code.ultimateRoot} && git log --oneline -1 && git status --short`)
const claudeCode = JSON.parse(
  await sh(
    `curl -s ${sys.process.url}/api/models | jq -c '{configured: (.providers[] | select(.id=="claude-code") | .status.configured), models: [.models[] | select(.provider=="claude-code")] | length}'`,
  ),
)
const ext = await ultimate.extensions()
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
}
```

`ultimate.system()` gives the host's clone (`code.ultimateRoot`) and URL (`process.url`). `/api/models` is large;
keep it in `jq`, out of your context.

## Report

The landed sha, whether it restarted and why, the health line (`generation`, extension errors, Claude Code models,
own model), the feature proof, and anything unverified named as such.
