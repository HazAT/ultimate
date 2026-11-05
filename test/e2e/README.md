# End-to-end tests

`pnpm test:e2e` runs the suites under `test/e2e` with vitest (`test/e2e/vitest.config.ts`): real
servers, real browsers, real time — everything the fast suites must not do. CI runners and
containers run them too; the two things an environment needs are below.

## Browser

The browser tool launches headless Chromium (see `extensions/browser/README.md` for resolution:
`ULTIMATE_CHROMIUM`, `/usr/bin/chromium`, Google Chrome, then the Playwright cache). In CI:

```
pnpm exec playwright-core install --with-deps chromium
```

Chromium's sandbox is on by default. It needs unprivileged user namespaces or a working setuid
`chrome-sandbox` helper; where the environment cannot provide either (most hosted runners, root in a
container), launches die with "Chromium sandboxing failed!". The two tests that launch a browser
stub `ULTIMATE_CHROMIUM_SANDBOX=0` themselves — a variable in the outer environment cannot reach the
extension, because `test/helpers.ts` strips every `ULTIMATE_*` variable from the worker env. Turn
the sandbox off elsewhere with the env var before starting Ultimate.

The timed calls bound the browser launch too (the guard wraps `state.launched`), so on a quiet
runner a cold launch can outrun a short `timeoutMs`. The tests that drive a browser with tight
budgets warm the browser with one default-budget call first; keep that pattern in new tests.

## Flakes

A failure reruns once before it counts; a test that fails twice without a code cause is fixed or
deleted, not skipped and not given a longer timeout (`fast-test-reason:` comments and
`test/e2e` are the only exceptions to the fast-suite rules). One flake entry per bug that actually
happened: name the mechanism, not the symptom.
