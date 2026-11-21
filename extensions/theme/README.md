The "Toggle light and dark theme" command in the palette. The theme is a preference of the machine: the command
switches this browser at once with `context.setTheme` and keeps the choice as `theme` (`"light"` or `"dark"`) in
`~/.ultimate/settings.json`, which every Ultimate project on this machine shares even though each runs on its own origin.

Each server watches that file and records `theme.changed` when its `theme` changes, so every open page of every project
reads the file again and follows, with no polling. A page writes only when the user toggles, never to follow another
page. The shell keeps its own copy in `localStorage` and applies it before the first paint, so a reload does not flash;
a machine without a `theme` key keeps each browser's own choice until someone toggles.
