The built-in Agent surface: the conversation in a centred column, with the sidebar and the right panel beside it. It
is the home surface, shown by default and whenever another surface cannot be.

It is composed only of the primitives from `@/sdk/solid` (`Header`, `Sidebar`, `Conversation`, `Panels`, `StatusLine`), so
it doubles as the smallest example of a surface. To change it for yourself or one project, copy this folder to
`~/.ultimate/extensions/agent/` or `<project>/.ultimate/extensions/agent/`; the copy wins by name. If the Agent surface
fails to load, the host still shows a bare header, conversation, and status line, so you can always ask for a fix.

It also brings the conversation's commands: stop the run (`agent.stop`, Escape, also from the composer but not other
inputs) on every surface.
Compact the context (`agent.compact`), focus the composer (`agent.composer`), and show the main conversation
(`agent.main`) are available on every surface.
