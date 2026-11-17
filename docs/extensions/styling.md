# Styling and `data-ui` theming hooks

Part of the [extension guide](../../extensions/README.md).

- Use the components first: `@/components/ui/*` (shadcn: button, checkbox, collapsible, command, dialog,
  dropdown-menu, kbd, popover, switch, tooltip) and `@/components/ai/*` (code block, conversation, message, reasoning,
  shimmer, tool, prompt input). Need another shadcn component? `pnpm dlx shadcn@latest add <component>` writes it to
  `web/src/components/ui`.
- Style with Tailwind utilities and the theme tokens: `bg-background`, `bg-card`, `bg-muted`, `bg-terminal`,
  `text-foreground`, `text-muted-foreground`, `border-border`, `text-brand` (the one accent), `text-success`,
  `text-warning`, `text-error`, `text-diff-add`, `text-diff-del`. Opacity modifiers work: `bg-error/10`. They follow
  the light and dark themes; never hard-code colours.
- No new CSS files, no inline style objects for colours.
- A theme extension (a CSS file imported from its `web.tsx`) targets the app through stable `data-ui` hooks, never
  Tailwind classes: `titlebar`, `surface-tabs`, `wordmark`, `ultimate-button`, `sidebar-row`, `sidebar-section-header`,
  `conversation-header`, `turn-header`, `empty-state`, `transcript` (the entries' column), `transcript-steps` (an
  opened step list), `tool`, `card`, `message-card` (with `data-sender`) and its `message-card-body`, `composer`,
  `side-chat-hint`, `side-chat-switch`, `palette`, `status-line` and `transcript-meta` (the transcript's small
  dividers, folds and summary lines); selected rows and tabs carry `data-selected`, the sidebar's status dots `data-status` (`working`,
  `waiting`, `paused`, `done`, `failed` or `idle`) and the final answer `data-final`. Keep these when changing that
  markup.
- Dense and quiet: 12–14 px, monospace (`font-mono`) for meta such as paths, counts, ids, and durations; proportional
  for prose. Subtle borders (`border-border/70`), little motion.
