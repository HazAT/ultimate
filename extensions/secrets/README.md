Manage user-global secrets through metadata-only server actions, shared by every Ultimate project.

Values live in `~/.ultimate/secrets.json`, plaintext at 0600 in a 0700 directory, like Pi's `auth.json`. This is not a vault: the agent's shell runs as the same user and can access the file. Prompt guidance prevents accidental reading, not malicious access. Never include values in conversations, notices, documents, or logs.

The Secrets panel uses `list`, `set { name, value }`, and `delete { name }`. Rotation means setting the same name again; deletion removes it. Results contain metadata only. Writes use atomic rename under a pid-owned lock shared across processes. Unsafe file permissions are refused; fix them with `chmod 600 ~/.ultimate/secrets.json`.

Other server facets import `readSecret(userHome, name)` from `lib/secrets.ts`. A user-only action of another extension that takes a secret from its own card writes it through `SecretsApi.set` (`api.ts`); never from an agent tool. Declare required names through the server facet's `secrets` export. The store is independent of project state and `ULTIMATE_HOME`.

## UI

The Secrets panel (palette: `Secrets…`) lists every secret an enabled extension declares and every stored one. It reads `list` when it opens, after each save or delete, and when the enabled extensions change in system info.

- **Rows:** the name, the description, `needed by <extensions>` (or that no enabled extension needs it), a "Get a key" link for a declared `url`, and the status: `set · 5m ago` from `updatedAt`, or `missing`.
- **Add or Replace:** a password field with a show toggle, Save and Cancel (Enter and Escape). The value lives only in that component's state, goes to `set`, and is cleared after the save; nothing reads it back. There is no `<form>` and the field is a one-time code, so browsers do not offer to save it as a password.
- **Delete:** asks first, with focus on Cancel.
- **Errors:** inline, with the action's message.

While an enabled extension lacks a secret it declares, the `setup` status-line item warns, with an Add button that opens the panel at it.

Other facets open the panel at a row with `events.emit('secrets:open', { name })` from `@/sdk`, as parallel's Add key and onboarding do. Each save and delete emits `secrets:changed`.
