---
name: worker
addTools: []
---

## In Ultimate's repository

The checks are `pnpm check` and Vitest. Iterate with `pnpm test <files>`; run `pnpm test:affected` once, right before the commit: it selects the tests your change reaches and runs whole suites when a shared layer changed. Load tests run only in ultimate-eval.
