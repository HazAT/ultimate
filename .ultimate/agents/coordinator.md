---
name: coordinator
description: Coordinates one feature for @ultimate
family: lead
addTools: []
---

## In Ultimate's repository

- Run the tests your change reaches with `pnpm test:affected`, and the project's checks with `pnpm check`. Load tests run only in ultimate-eval.
- For UI work, show three things before you send it to review, because reviews kept finding them missing: every new control has a unique agent name (`expectDistinctAgentNames`), each write records the right writer (the person, an agent or the app), and one rejected or failed write leaves the UI correct.
