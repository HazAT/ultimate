Fast mode runs the OpenAI models named in `fastModels` on the priority service tier, about twice the output speed.

Set `fastModels` to `"provider/id"` names in `~/.ultimate/settings.json`, or in a project's `.ultimate/settings.json`,
which replaces the user's list:

```json
{ "fastModels": ["openai-codex/gpt-6.1-sol"] }
```

The composer toolbar shows a **fast** toggle while an `openai-codex/` (ChatGPT/Codex login) or `openai/` model is
selected. It adds that model to the user's `fastModels` or removes it (the `set` action), so it applies to every
request to the model, not just the shown conversation. While a project's settings set the list, the toggle is disabled
and the project file decides.

A definition can ask for it instead: `fast: true` in its frontmatter (the shipped `worker` sets it) puts the requests
of conversations running that definition on the priority tier, whatever `fastModels` says, so the lander on the same
model stays standard. It applies only on `openai-codex/` and `openai/` models; on any other provider it is ignored. Before
each request on an OpenAI model, a `beforeRequest` hook finds the definition the conversation runs (subagents'
`Profile` doc for children, automation runs and standing agents; else its label, as for branches and the lander),
reads that definition's current `fast`, and marks the request's provider session for the overlay. A compaction uses the
same session, so it follows the conversation's last request. An overlay file may set `fast` too.

Every request to a listed model goes fast: conversations, subagents whose definition names it (workers, the lander,
reviewers), and summaries. The list is read at each request, so a change applies to the next one. Only `openai-codex/`
and `openai/` models are accepted; any other entry turns fast mode off with a notice.

The extension registers an overlay on both providers whose stream adds `service_tier: "priority"` to the Responses
payload of listed models and leaves every other request unchanged. pi-ai's simple stream options drop `serviceTier`,
so it is set through `onPayload`, after the caller's own hook. The ChatGPT login rejects the documented `"fast"` value
and accepts `"priority"`, the same tier.

Fast mode costs more. With the ChatGPT login it uses the plan's included usage at 2.5× the Standard rate; with an API
key it is billed at 2× Standard. The ChatGPT login reports `service_tier: "default"` even for priority requests, so
displayed costs stay at Standard list prices.

Verification: `pnpm vitest run extensions/fast/test/fast.test.ts`.
