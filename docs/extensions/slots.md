# Contributions: slots and panels

Part of the [extension guide](../../extensions/README.md).

`defineWebExtension({ slots, panels, surfaces, tools, toolLines, entries, link, messageActions, messageDetails, answerLabels, userBubble, compact, documents, commands })`; every key is optional. Extensions load
in parallel, installing independently; contributions follow discovery order: built-in → user → project, then folder name within each source. Give a slot item `{ component, order }` to move it (default order 0, lower first).
Renderers (`tools`, `toolLines`, `entries`, `link`, `codeBlocks`, `messageActions`, `messageDetails`, `answerLabels`,
`userBubble`, `compact`, `inbox`, `composer`) are in [renderers](renderers.md), `documents` in
[documents](documents.md), `commands` in [commands](commands.md) and `provides` in [web points](contracts.md#web-points).

## Slots

Components mounted in named places of the shell, on every surface that renders the primitive holding them, and in the
title bar the host shows above every surface.

| Slot                   | Where                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sidebar`              | Left column (`<Sidebar />`); it disappears while nothing is in it                                            |
| `sidebar.top`          | Agent sidebar, after the Agents group and before the roots: background work such as watches                  |
| `titlebar.brand`       | Title bar, the wordmark beyond a phone; render `Wordmark` from `@/sdk` with an `onClick`                     |
| `titlebar.project`     | Title bar, in place of the project chip; render `ProjectChip` from `@/sdk` with a menu                       |
| `titlebar.left`        | Title bar above every surface, after the project chip; monospace, one line                                   |
| `titlebar.right`       | Title bar, right, before the palette button                                                                  |
| `header.right`         | Right side of the header, before the panel toggle (`<Header>`)                                               |
| `statusline.left`      | Bottom status line, left; monospace, one line (`<StatusLine />`)                                             |
| `statusline.right`     | Bottom status line, right (`<StatusLine />`); on a phone only `phone: true` items stay, the rest go behind ⋯ |
| `composer.toolbar`     | Left of the composer's footer; a size container, condense with `@max-md:` (`<Conversation />`)               |
| `composer.status`      | Line under the composer; conversation-specific, monospace, one line (`<Conversation />`)                     |
| `composer.actions`     | Composer footer, beside Send; input helpers that write into the draft with `insertIntoComposer`              |
| `conversation.overlay` | Over the transcript and the composer (`<Conversation />`); position it `absolute inset-0`                    |
| `transcript.top`       | At the top of a transcript's view as it scrolls, over its rows; `useTranscript()`, `useTranscriptScroll()`   |
| `transcript.start`     | Above a transcript's first row once its whole history is loaded; `useTranscript()` inside                    |
| `transcript.end`       | After a transcript's last row, before the working line: a turn still forming, such as live speech            |
| `overlay`              | Always mounted at the root, above every surface: dialogs, toasts, global effects                             |
| `shell.rail`           | Full-height column at the window's left edge, beside the title bar and every surface; not in a frame         |

```tsx
slots: { 'header.right': [Badge], sidebar: { component: Conversations, order: -1 } }
```

## Panels

Tabs of the right panel (toggle: `mod+alt+b`).

```tsx
import { InfoIcon } from 'lucide-react'
panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel }]
```

Open one from code with `useUltimate().openPanel('info')`. A panel with `tab: false` stays out of the tab row until
something opens it (a command, a sidebar row); give it a ⌘K command. Panels show on surfaces that render `<Panels />`, such
as Agent.

## Surfaces (apps)

Full-screen apps the user switches between, with the agent one keystroke away; [Surfaces](surfaces.md) explains
them, with the primitives, and [the Commits example](example-app.md) is a complete one.

```tsx
surfaces: [{ id: 'commits', title: 'Commits', icon: GitCommitHorizontalIcon, component: Commits }]
```
