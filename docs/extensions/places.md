# Where extensions live, settings and secrets

Part of the [extension guide](../../extensions/README.md).

Ultimate looks for extension folders in three places. When two have the same folder name, the later place wins and
replaces the whole extension, both facets:

| Source    | Folder                            | For                                                                |
| --------- | --------------------------------- | ------------------------------------------------------------------ |
| `builtin` | `extensions/` in Ultimate's clone | Ultimate's own features, shipped with it                           |
| `user`    | `~/.ultimate/extensions/`         | Your additions, in every project                                   |
| `project` | `<project>/.ultimate/extensions/` | One project's tools and apps, committed with the project; wins all |

A tool name follows the same layering: a project or user extension may override a built-in's tool (a project `bash`
replaces coding-tools'). Two extensions of the same source may not share one: the one that loaded second fails with
a load error such as `web_search is already provided by parallel`, and takes the name on its next reload once the
other is disabled or removed.

Every extension folder is on by default, built-in, user or project: adding the folder is the opt-in. The exception is
the built-ins listed in `defaultOff` (`shared/extension-api.ts`; see [settings](../settings.md)), which need
something of their own and ship off until `extensions.enable` names them (including `voice-live`, the live voice relay). Turn one off
with `{ "extensions": { "disable": ["hello"] } }` in `~/.ultimate/settings.json` (this machine) or
`<project>/.ultimate/settings.json` (this project), and back on with `extensions.enable`. Settings layer defaults →
machine → project; later layers win. Settings changes apply live without a restart; unknown names produce a notice.
A core-tier extension (`export const tier = 'core'` in its `api.ts`, such as conversations, workspaces, subagents,
lineage, messages and sidebar) stays on whatever the settings say, and depends only on other core-tier extensions: an
optional extension plugs into it through a point or an event, never the other way round (lint `core-tier-deps`; see
[Core tier](core-tier.md)).

## Secrets

The `parallel` web tools read their key from `secrets`. Secrets are user-global, not project state.

A server facet may export `secrets: { name: string; description: string; url?: string; provider?: string }[]`, or a function of its host returning (a promise of) that list, called at each install; with `reloadOnSettings` it follows the facet's settings (mcp declares its `${NAME}` placeholders this way). Names must match `^[A-Z][A-Z0-9_]*$`, descriptions must be non-empty, and optional URLs must use http(s). `provider` names a model provider whose configured auth stands in for the secret: the setup check stops reporting it missing once that provider has auth. Installed declarations appear in `ExtensionInfo.server.secrets` and the Secrets panel; values never appear in extension info. Other server facets read values with `readSecret(userHome, name)` from `lib/secrets.ts`; only the secrets extension writes them.

The `tailscale` built-in, once enabled, exposes Ultimate to your own Tailscale login; only user settings set its allowlist. See [tailscale](../../extensions/tailscale/README.md) for stable project URLs and owner-login admission.

## Projects, agents and skills

The project is the directory Ultimate was started in (`ultimate [dir]`); the Info panel lists every extension with its
source when `info` is enabled; the building-blocks prompt names the clone root. Put a project's app in its `.ultimate/extensions/<name>/`. When the
project is Ultimate itself, that is `.ultimate/extensions/` in the clone, not `extensions/`, which holds the built-ins.

Extensions outside the clone import exactly what built-ins import (`@/sdk`, `@/components/…`, `react`,
`lucide-react`, any package installed in the clone): Ultimate resolves those from its clone, and Tailwind picks up their
classes. In the clone, `pnpm check` type-checks and lints `extensions/` and `.ultimate/extensions/`; extensions of
other projects are not checked by anything, so try them in the browser. Agents live in the same three places
(`agents/`); an enabled extension may also ship an `agents/` folder. Those definitions load as built-ins before
user/project definitions and overlays, and disappear when the extension is disabled. Skills load as [Discovery and settings](../settings.md) describes, later scopes winning by name. A project's `.ultimate/settings.json` may set `defaultSurface` (see
[Surfaces](surfaces.md)).
