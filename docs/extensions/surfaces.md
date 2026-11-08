# Surfaces

Part of the [extension guide](../../extensions/README.md).

The window shows one surface at a time. **Agent** is the built-in home surface (`extensions/agent`): the conversation
with the sidebar and the right panel. An app surface puts its own UI first and keeps the agent one keystroke away,
usually docked beside it. The `documents` extension provides the Documents tab.

- **Switching**: the title bar lists the surfaces as tabs (Agent first, then by `order`, then title); on phones the brand
  opens them as a menu. ⌘K has "Switch to …"; `mod+1…9` select the first nine (Ctrl+1…9 off macOS, which Chrome lets
  the page take before its tab switching). In code: `useUltimate().showSurface(id)` or
  `context.showSurface(id)` in a command. Switching never interrupts the agent: the run goes on, and the transcript and
  the composer's draft are where they were.
- **Durable**: the choice is UI state `shell.surface`; it survives reloads and restarts and follows every tab. Until the
  user picks one, a project's `.ultimate/settings.json` (`{ "defaultSurface": "commits" }`) chooses, if that surface
  is installed.
- **Failure**: if the chosen surface is not installed, or its component throws, Agent shows instead, with a notice; a
  fixed version comes back on its own. If even Agent fails, a bare header, conversation, and status line remain. The
  window title and `surface` below name what is on screen, so Agent while it stands in.
- `useUltimate().surface` and `context.surface` give the id of the surface on screen.

The contribution:

| Field         | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `id`          | Global and stored in `shell.surface`: use the extension name (`commits`) or prefix it (`commits.graph`) |
| `title`       | Shown in the switcher, the title bar, ⌘K, and the window title                                          |
| `icon`        | A `lucide-react` icon                                                                                   |
| `description` | One line under the title in the switcher                                                                |
| `order`       | Position after Agent; lower first (default 0), then by title. It decides which `mod+<n>` selects it     |
| `component`   | The surface itself                                                                                      |

## Layout

The host renders the surface inside a column that fills the window (`flex h-dvh flex-col`), under its title bar: the
brand, the project, the surfaces, and the palette button (none when Ultimate is embedded in an iframe).
Compose the surface top to bottom, and make the middle row `flex min-h-0 flex-1` so it takes the rest and scrolls
inside, not the page:

```tsx
function MyApp() {
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        {/* your columns; a scrolling one gets min-h-0 (or min-w-0) and overflow-y-auto */}
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}
```

## Primitives

Import them from `@/sdk`. Each is a thin wrapper over the shell's own parts; the Agent surface is nothing but these.

| Primitive                                 | What it renders                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Header>`                                | The surface's top bar: its children (by default the shown conversation's trail) and the `header.right` slot. It adds the sidebar and panel toggles when the surface renders them.                                                                                                                   |
| `<StatusLine />`                          | The bottom line with the `statusline.left` and `statusline.right` slots                                                                                                                                                                                                                             |
| `<Conversation variant="main" \| "dock">` | The shown conversation: transcript and composer, filling their box. `main` centres a reading column; `dock` fits a narrow region.                                                                                                                                                                   |
| `<Dock title? side?>`                     | A collapsible, resizable side region, `right` by default; `title` (default `conversation`) labels it. Drag the inner edge to resize, double-click it to reset. Collapsed, it is a rail that pulses while the agent works. Open state and width persist per surface (`shell.dock.<surface>.<side>`). |
| `<Sidebar />`                             | The `sidebar` slot as a left column, toggled with `mod+b`; nothing while the slot is empty                                                                                                                                                                                                          |
| `<Panels />`                              | The right panel with every extension's panel tabs, toggled with `mod+alt+b`                                                                                                                                                                                                                         |
| `<Slot name variant? />`                  | Any slot by name, each item in its own error boundary; `variant="inline"` for one-line places                                                                                                                                                                                                       |

Everything else on a surface is your own components, styled like the rest of Ultimate (see [styling](styling.md)).
A transcript card (a subagent report, a message, a catch-up) is a `<Card>`: a bordered section with the brand accent on
its left edge; `className` adds layout, such as padding or `overflow-hidden`.
Pass the header your own title or controls as children: `<Header><span className="text-[13px]">12 open</span></Header>`.
