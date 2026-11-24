Antigravity is an experimental provider that runs the models of the user's Antigravity CLI (`agy`) login as normal
Ultimate models, with a setup panel and no in-app login.

It is on by default; turn it off with `antigravity` in `extensions.disable`. With `agy` missing or signed out, it shows
no models.

## Setup

Install the Antigravity CLI and sign in once in a terminal (`agy`). Open **Antigravity setup…** in the command palette
and refresh status. Once `agy models` lists models, pick one in the model picker, an agent definition or a family:
the same ids `agy models` prints, under the provider `antigravity` (for example `antigravity/gemini-3.8-flash-high`).
A model Google adds to the account later shows up after a refresh, without a code change.

## How a turn runs

Pi keeps the loop, the tools, the history, approvals and durability, as for any model; Antigravity only answers the
model call.

- Antigravity models use pi-ai's `google-generative-ai` API with a loopback relay as their base URL.
- For each model call the relay starts `agy -p` with `CLOUD_CODE_URL` pointing back at itself. It passes `agy`'s setup
  calls through to Google's Code Assist endpoint (`https://daily-cloudcode-pa.googleapis.com`), takes `agy`'s first
  agent request, replaces its model and request (contents, system instruction, tools, generation config) with Pi's,
  and streams it upstream with `agy`'s own headers and session metadata. Code Assist's `{response}` stream frames
  are unwrapped back to the Gemini API's shape.
- `agy` itself gets a finished one-word answer, so it never runs a tool, then is stopped.
- Model discovery runs `agy models` through the same relay and reads the limits Code Assist reports for each model.

`PI_ANTIGRAVITY_COMMAND` selects the executable (default `agy`).

## Raw Gemini requests from extensions

Use `host.need(AntigravityApi).generate(model, request, signal)` to send a raw Gemini request. Pass an object for
small requests or an `AsyncIterable<Uint8Array>` of JSON bytes to stream large inline media without buffering the
whole request. The relay adds `agy`'s `sessionId` and `labels`; leave those fields out of the Gemini request.
The result includes text without thoughts, the finish reason if present, and token usage. Upstream errors include
an HTTP status and Google's message when available; 401 and 403 only show a sign-in hint, never Google's body.

## Credentials and terms

`agy` owns its login. The relay never stores, logs or copies its tokens: they pass through in memory for the one
request they sign. Status exposes only whether `agy` is installed and signed in, and its model names.

Google's Antigravity terms say wrapping `agy` in third-party applications is not supported on consumer plans. The user
chose to run it anyway for their own development; this extension is experimental and may stop working when Google
changes the CLI or its endpoint.

Tests: `extensions/antigravity/test/relay.test.ts`, against a fake `agy` and a fake Code Assist endpoint.
