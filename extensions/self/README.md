Ultimate's awareness of its own code: the replay-safe `restart` tool requests a type-checked core swap from the supervisor (`pnpm start`). Failed preparation returns diagnostics while the old core continues. The tool saves the next generation before activation; replay reports the running generation or activation rollback.

Call after authorized changes to `server/` or `shared/`, and after a landing that changed packages (`patches/` or `pnpm-lock.yaml`). Never call for `web/`, `extensions/`, or `agents/`: those reload without a core swap.

An isolated conversation must first land into the running Ultimate clone. Restart requires that clone to be clean and its HEAD to equal the workspace's saved landed commit; otherwise it asks you to land first. A shared conversation, including one in a project subdirectory, uses ordinary restart behavior.

Restart affects all conversations. Landing never restarts automatically. A restart first waits for the `onBeforeLoad` callbacks (the `update` extension's install of owed packages) and is refused when one fails. `POST /api/restart` requests the same swap; reconnect to `/api/events` to observe readiness.

`web.tsx` renders restart results, build information, and transcript reload markers. While `server/` or `shared/`
changed since this core booted, the status line shows `core changed · restart` just left of `live · gen N`; clicking
it restarts the host, and a failed restart turns it into `restart failed` with the reason in a popover.
After the page switched to a new web bundle (`server/web.ts`), a quiet toast above the bottom right of the status line
names the sources that changed for 4 s, or the landing that brought them when one was recorded within a minute.
