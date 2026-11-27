# Page agent

Lets an agent drive the user's own Ultimate page: its `ui` tool runs ui-sdk `snapshot`, `query` and `act` on a page
open in the user's browser and returns the result.

## Who gets the tool

`ui` is deferred and callable only by the model (not from codemode scripts), so no agent is offered it by default. A
conversation gets it when its owner enables and loads it: voice mode adds it to every voice fork
(`voice-live/server.ts`, `openSession`). No agent definition names it.

## Requests

`ui {op: query | act | snapshot}` records the request on the `page-agent.calls` document on conversation 1 as
`{ id, conversation, task, op, input, at, page? }` and parks durably for 15 s, waking on the answer's signal.
`page` is the page the caller named: `PageAgentApi.namePage(tx, conversation, page)` stores it per conversation, and
voice names the page that sent each turn. A finished, failed or cancelled call removes its request.

## Pages

Every page mounts a headless overlay (`runner.solid.tsx`) that watches the document. A page takes a request with
`claim {id, page, visible}`: only the named page may, or any visible page when none is named, and the first claim
wins. It runs the request on `pageAgent()` from `@/sdk/solid` and sends `answer {id, page, result}`, which signals the
parked call; an answer from any other page is ignored. `pageId` (`ui.solid.tsx`) is the page's id for its life.

With no answer within 15 s the call fails: a claimed request says it may or may not have run, an unclaimed one says
which page must be open.
