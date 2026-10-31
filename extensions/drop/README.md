Files dropped into the conversation: the composer inserts the absolute path a dropped file has on this machine, and a shift-drop copies the file into the conversation's own folder.

Built in and on by default, because the shell's drop wiring calls it: with `{ "extensions": { "disable": ["drop"] } }`
a Finder-style drop has no name to look up and no folder to copy into. A browser never reveals the path behind a file
dragged from Finder, so the composer asks this extension. Both actions are also callable from an agent with codemode
`ultimate.action('drop', …)`.

- `resolve { name }` → `{ paths }`: at most eight absolute paths of files called `name`, shallow matches first. It
  searches `~/Desktop`, `~/Downloads`, `~/Documents`, the project's worktrees under the state home, and the project
  root, never entering hidden folders, `node_modules`, builds or version control, and it gives up after 4 folders deep,
  3000 folders or 0.8 s so a drop stays instant. Exactly one match is inserted; several show a picker in the composer;
  none copy the file in instead.
- `save { name, data }` → `{ path }`: writes the dropped bytes (base64, up to 8 MiB) into
  `<state home>/attachments/<conversation id>/`, numbering a name already there, and answers with the absolute path.
  The name is reduced to one file name, so nothing is written outside that folder.

`drop.roots` in `~/.ultimate/settings.json`, or in the project's `.ultimate/settings.json` which extends the user's,
adds folders to search; `~/` means the user's home:

```json
{ "drop.roots": ["~/src/notes", "/Volumes/Archive/inbox"] }
```

The shell's own drop handling — nothing navigates, the path is inserted, images attach, shift copies in — lives in
`web/src/app/drop.tsx`; this extension is what makes a Finder drop and a copy land somewhere on this machine.
