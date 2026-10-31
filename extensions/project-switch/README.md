Open another project at the same URL: ⌘K **Open project…** picks a folder and restarts the Ultimate service in it.

Off by default: it needs a host where the systemd unit `ultimate.service` serves Ultimate, a drop-in that reads the
project from `~/.ultimate/current-project`, and passwordless `sudo` for `systemd-run`. Turn it on with
`"extensions": { "enable": ["project-switch"] }` in `~/.ultimate/settings.json`.

## Host setup

One systemd service (`ultimate.service`) serves Ultimate at one URL. Its drop-in, for example
`/etc/systemd/system/ultimate.service.d/project.conf`, reads the project folder from `~/.ultimate/current-project`
(an absolute path; missing or not a folder means Ultimate's own repo), so switching projects is writing that file and
restarting the service:

```ini
# The project comes from ~/.ultimate/current-project (an absolute path); missing or not a folder: Ultimate's own repo.
[Service]
ExecStart=
ExecStart=/bin/bash -c 'p=$$(cat /home/me/.ultimate/current-project 2>/dev/null); [ -d "$$p" ] || p=/home/me/ultimate; cd "$$p" && exec /usr/bin/node /home/me/ultimate/bin/ultimate.ts "$$p" --port 4747 --no-open'
```

The service's user needs passwordless `sudo` for `systemd-run` (a sudoers line such as
`me ALL=(root) NOPASSWD: /usr/bin/systemd-run`).

## Picker and actions

The picker (`project-switch.picker`, shaped like the model picker) lists projects opened before (from the project
homes in `~/.ultimate/projects/*/project.json`), git repositories directly under the home folder, and a typed
absolute path; the current project carries a check.

Actions:

- `list` (no arguments) → `{ current, home, opened: [{ path, name, openedAt? }], repos: [{ path, name }] }`.
- `open { path }` → `{ path }`. User-only (it ends every running conversation): refuses anything but an existing
  absolute folder, writes `~/.ultimate/current-project`, then restarts the service through a one-second transient
  systemd timer (`sudo -n systemd-run --on-active=1 … systemctl restart ultimate`). The timer runs outside the
  service, so the restart survives the service stopping its own processes, and the reply reaches the browser first.
  If the timer cannot be scheduled the file is put back.

After the restart the browser does what it does for any server restart: the status line shows reconnecting, and
Vite's client reloads the page once the server answers again, now serving the new project.
