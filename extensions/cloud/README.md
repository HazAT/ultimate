Backs up your projects, encrypted, to a cloud server you run yourself (needs setup and two keys).

Encrypted project backups in the user's cloud, inert until configured. A project runs on whichever machine the user
starts it on; the cloud holds its backups and a register of which machine backed up what, and `pnpm restore` installs
a backup on another machine.

Configure once in **user** settings (`~/.ultimate/settings.json`), or with ⌘K → **Join cloud backups**:

```json
{ "cloud": { "url": "wss://example.com", "machine": "my-machine" } }
```

Add `ULTIMATE_CLOUD_TOKEN` (the Worker's bearer token) and `ULTIMATE_CLOUD_SNAPSHOT_KEY` (encrypts backups; the same
value on every machine) in the Secrets panel. `machine` defaults to the OS hostname. Project settings are never read: a
repository cannot redirect the user's history to another server. Environment overrides take precedence, for
process-scoped experiments: `ULTIMATE_CLOUD_URL`, `ULTIMATE_CLOUD_TOKEN`, `ULTIMATE_CLOUD_SNAPSHOT_KEY` and
`ULTIMATE_CLOUD_MACHINE`. Preview instances stay silent unless `ULTIMATE_CLOUD_URL` is set explicitly;
previews strip the cloud variables they inherit.

A project is its GitHub repository (`lib/project-identity.ts`): the `origin` remote normalised to
`github.com/<owner>/<repo>`, lowercased. A project without a GitHub origin cannot be backed up; its status line says
`not backed up`.

## Satellites

A satellite is another machine that runs a project beside the machine that backs it up (the project's owner), for
example a laptop doing platform work that it pushes as `satellite/*` branches for the owner to land. Its own history
must never replace the owner's backups, so on the satellite set, in user settings:

```json
{ "cloud": { "url": "wss://example.com", "machine": "my-laptop", "satellite": true } }
```

Its backups then refuse before uploading anything, forced or not, for agents, Dream and the status line alike; the
status line shows `satellite · no backups` with no backup buttons. The satellite still reads the register, so it
reaches the owner (answers to its `tell`s included).

A satellite never commits a backup, so the register holds no tailnet address for it. Machines that reach it name its
address in the general `remotes` user setting ([Discovery and settings](../../docs/settings.md)), which is asked
before the register.

`api.ts` exposes optional `CloudApi`: `status()` returns `off`, `local`, `satellite` or `on`, and `backup()` performs the same
non-forced backup of the active chapter as the user action; `lastBackup()` returns the chapter's last backup from
`cloud-backup.json`, else from the Worker's register. Dream uses them for the final backup before falling asleep and
the new chapter's first backup after it; missing, off, local-only or satellite cloud is skipped explicitly. Cloud still ships disabled by default.

## Cloud backups

The Worker lives in the private repository `HazAT/ultimate-fleet` and is deployed from there. Every `/sync/*` route
needs `Authorization: Bearer <ULTIMATE_CLOUD_TOKEN>`; `<p>` is the SHA-256 hex of the project key:

- `PUT|GET /sync/snapshots/<p>/<id>/<name>`: the encrypted objects of one backup (`snapshot.ts`).
- `POST /sync/backups/<p>/<id>`
  `{ key, name, chapter: { name, number }, machine, parent, force?, createdAt, bytes, uploaded, tailnet? }`,
  after the manifest is up: makes `<id>` the project's latest backup. `chapter` names the chapter the backup belongs
  to (`the-beginning`, 1 for the first, whose key has no `@` suffix), so the fleet can group a project's chapters by
  name and order. `200 { latest }`, or `409 { error, latest }` when
  `parent` is not the project's latest (`error` is a sentence for the user, `latest` the register's
  `{ id, machine, at, bytes, uploaded, parent, tailnet? }`).
- `GET /sync/register`: `{ projects: [{ hash, key, name, latest }], machines: [{ machine, at, projects }] }`.

**Back up now** (`backup { force? }`, also callable by agents) uploads an encrypted snapshot of the open database and the `ultimate/*`
branches, then commits it with this home's **parent**: the backup it last uploaded or restored, kept in
`<home>/cloud-backup.json` (`{ key, parent, last }`). The commit names the machine, the project's folder name, the key, the chapter's name and number,
and the tailnet address (from `tailscale`, when published). On 200 the new backup
becomes the parent. On 409 another machine backed up after this home's parent: the parent stays, the uploaded chunks
stay for the Worker's retention, and `state` reports `conflict { error, latest }`. Two 409s are this machine's own and
not conflicts: one whose `latest` is this very backup (a retried commit already made) counts as done, and one whose
`latest` this machine made on top of its recorded parent (registered, but answered with a 500) becomes the parent, and
the commit is retried once on it; that answer is final. One backup runs at a time, and none
while paused.

The parent rule keeps two machines from silently overwriting each other's history: whoever backs up from a stale parent
is told. **Back up anyway** sends `force` and replaces the latest backup; the older one stays until retention prunes
it.

`cloud.backup` (`BackupEvent`) records each backup for the System stream: `started` `{ project }`, then `done`
`{ bytes, uploaded, ms }` or `failed` `{ ms, reason }`, where `reason` is classified (`conflict`, `HTTP 503`,
`integrity check failed`, …, else `failed`) and a `conflict` adds the Worker's sentence as `error`. Each commits on its
own right after the upload it records.

The **status line** shows `backed up 3h ago` (`no backup yet`, `backing up…`). Its popover has the last backup with
its machine and size, **Back up now** with the upload's progress, a refused backup's sentence with **Back up anyway**
(and a confirm naming the backup it replaces), and the restore command for reference.

**Restore** on another machine, with Ultimate stopped in that checkout:

```sh
pnpm restore [name|key] [--snapshot <id>] [--chapter <name>] [--dir <project dir>] [--yes] [--dry-run]
```

It reads the checkout's key (`--dir`, else the current directory) and finds the project in the register (by name or
key, default the checkout's own); `--snapshot <id>` skips the register and restores that backup of the checkout's own
project, so backups the register never listed still restore. It refuses while an Ultimate holds the home's
`ultimate.lock` (the supervisor) or `storage.lock` (a standalone server), naming its pid, and holds both until done.
It downloads and verifies the backup (the latest unless `--snapshot`); a backup records its checkout's path as the
manifest's `root`, and one taken at another path is refused before anything is written, since conversations and
worktrees name absolute paths (backups without `root` restore with a warning). Then it journals the restore in
`<home>/reset.json`, moves the home's state into `~/.ultimate/backups/restore-<time>/<home>/`, installs the backup as
`state.sqlite`, writes `cloud-backup.json` with it as the parent, so the next backup from here builds on it, and removes
the journal. While the journal exists no Ultimate opens the home; `pnpm restore` again finishes the interrupted restore
into the same backup folder from the download it kept. It prints the backup folder and the `mv` that undoes it.
`ULTIMATE_HOME` selects the home like `pnpm reset`.

Restore defaults to the home's active chapter (`the-beginning` if there is no `chapters.json`). `--chapter <name>`
selects another; an explicit `<key>@<name>` also selects that chapter. Later chapters use the cloud key `<key>@<name>`
(including with `--snapshot`), install into `<home>/chapters/<name>/state.sqlite`, and keep `cloud-backup.json` there.
Only that chapter's old state moves aside, into `~/.ultimate/backups/restore-<time>/<name>/`; the home-wide journal and
locks still guard the restore. Restoring a later chapter registers it in `chapters.json` if needed and makes it active.
The first chapter keeps the original key, paths and restore behaviour.

**Join** (⌘K → **Join cloud backups**, or **Join** on the setup row) asks for the cloud URL, machine name and both
secrets, checks `GET /sync/register` with the token (401: "The cloud refused the token"; anything else but 200:
"Cannot reach <host>"), and only then stores the secrets and `cloud.url`/`cloud.machine`. It lists the projects the
register knows. Backups read the configuration from the next start on.

## Snapshots

`snapshot.ts` copies the database consistently with a read-only `VACUUM INTO` (an open database's committed WAL
included), bundles the `ultimate/*` branches when there are any, compresses both with zstd and uploads them in chunks
of at most 16 MiB, then an encrypted manifest with each part's plaintext SHA-256, size, chunk count and uploaded
bytes. Every object is AES-256-GCM with a random nonce, under a key derived per snapshot with HKDF-SHA256 from
`ULTIMATE_CLOUD_SNAPSHOT_KEY`, salted with the project key; the associated data names the snapshot, part, index and
whether it is the last chunk, so altered, reordered, swapped or dropped chunks, another secret and another project all
fail verification. Manifests written for the retired lease also carry an `epoch`, which is ignored.

`downloadSnapshot` verifies and writes `<dir>/snapshot-<id>.sqlite`, checks its integrity, and adds the branches
without force: new ones are created, older ones fast-forwarded unless checked out in a worktree, ones already
containing the incoming commit stay, and any other keeps the local branch and stores the incoming one as
`refs/heads/ultimate-moved/<id>/<name>`. On failure it removes only its own files. Requests retry twice after network
errors and 5xx answers.
