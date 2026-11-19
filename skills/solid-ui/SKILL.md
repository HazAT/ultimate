---
name: solid-ui
description: Write or review Solid 2.0 UI in Ultimate (a `*.solid.tsx` file, a UI kit component, a Solid extension facet) with ui-sdk components and behaviors. Use before writing or changing any `.solid.tsx` file or anything under web/src/components/ui, and when moving a React component to Solid.
---

# Solid UI in Ultimate

Ultimate's UI is moving from React to Solid 2.0, with Vercel UI SDK (`@ui-sdk/*`) underneath its components. Both are
newer than most models' training data, and Solid 2.0 is not Solid 1.x, so habits from either one are the main source of
bugs. The skills that the libraries ship match the exact pinned versions: read them, not your memory.

## Read first, from the installed packages (in the Ultimate clone)

1. `node_modules/solid-js/skills/solid-2.0/SKILL.md`: the three rules and the table of Solid 1.x names that no longer
   exist. Read it every time before you write Solid.
2. `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md`: how to compose ui-sdk, make it agent-ready and test it. Our
   framework is `solid`, so its docs index is `node_modules/@ui-sdk/solid/docs/llms.txt`; open only the component pages
   you use.
3. When an unfamiliar name comes up: `node_modules/solid-js/CHEATSHEET.md`.
4. When dev mode prints a `[CODE]` diagnostic: its section in
   `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`. Fix the cause, never suppress the code.

## What ships today

The toolchain, lint and these skills. A `*.solid.tsx` file compiles with Solid and lints with the rules below. The SDK's
island mount, its Solid bindings and the Solid UI kit come in the next steps; until they land, `@/sdk` and
`@/components/ui` are React-only, so a Solid file cannot yet be mounted as an extension facet or import a kit component.
Check `web/src/components/ui/` and `web/src/sdk/` before assuming either exists.

## Ultimate's rules (on top of those skills)

- **One renderer per file.** Solid code lives in `*.solid.tsx` and imports no React, React components or React
  libraries; React files import no Solid and no `*.solid.tsx`. The two meet only in `web/src/sdk`. Lint:
  `ultimate/ui-framework-boundaries`.
- **ui-sdk only through the UI kit.** Components come from `@/components/ui`, which wraps ui-sdk once and carries our
  theme. For a behavior the kit lacks, build it with `definePrimitive` from `@ui-sdk/core` and add it to the kit.
  Lint: `ultimate/ui-framework-boundaries`, `ultimate/ui-kit-roles`.
- **Our theme, ui-sdk's states.** Style with our tokens (`text-muted-foreground`, `bg-muted`, `border-border/70`,
  `text-brand`) and ui-sdk's state attributes (`data-pressed:`, `data-checked:`, `data-open:`, `data-disabled:`), never
  inline styles for state. The UI stays dense and quiet, with `font-mono` for meta.
- **Name every control** with a visible label or `aria-label`: people using screen readers and agents both find
  controls by name.
- **Say what agents may do**, as the ui-sdk skill's `references/agent-ready.md` describes:
  `data-agent-confirm="what it does"` on an action that needs a person; `data-agent-secret` on a field an agent may fill
  but never read (password, card and one-time-code fields already are); `data-agent-hidden` on a region agents should
  not see at all; and `agent: { secret: true }` in a `definePrimitive` whose value must never be read.
- **State that should survive** a reload, a restart or a second tab is durable: bind it through `@/sdk` (UI state or a
  document) once its Solid bindings exist, not a local signal.
- **Lint is the floor, not the bar.** `pnpm check` runs eslint-plugin-solid's `v2-strict` set (Solid 2 semantics) as
  errors, plus accessibility rules and ours, on every `*.solid.tsx`. Never disable a rule inline. A false positive is a
  report to the coordinator, with the code and the rule.

## Done means

1. `pnpm check` passes.
2. Tests for the behavior, as the ui-sdk skill's testing reference describes.
3. Look at it with the `verify-ui` skill; for a visible change, a preview round.
4. Report anything the skills, docs or types got wrong, so this skill or a lint rule can catch it next time.
