---
name: measure-switch
description: Measure and profile how fast Ultimate's UI switches conversations, on a paused copy of the project's real database, in a real Chromium with a CDP CPU profile. Use when asked to make conversation switching, the sidebar or the transcript faster, or to check that a change did not make them slower.
---

# Measure conversation switches on real data

A fresh preview has a handful of conversations; the slow paths only show with a long history (thousands of
conversations, megabytes of list and view). This recipe copies the real database into a scratch home that opens
**paused**, runs a preview on it, and drives switches in Chromium.

The copy holds private conversations: keep it outside the repository, never commit or paste its contents, and delete
it when done.

## 1. Copy the database, paused

```bash
SRC=~/.ultimate/projects/<project-home>/state.sqlite   # or chapters/<name>/state.sqlite for a later chapter
node .ultimate/skills/measure-switch/copy-paused.ts $SRC $HOME/switch-perf/home
```

It reads the source with `VACUUM INTO` (never moves or writes it) and appends a manual pause to the copy's root
`pause.state`, so queued inputs, interrupted runs and automations stay held instead of calling models. Run it from a
checkout whose `pause` extension matches the source's version. Pick the chapter with the shape you need:
`chapters.json` names them; the first chapter is `<home>/state.sqlite`.

## 2. Start a preview on it and confirm the pause

`instance start {home: "<absolute $HOME>/switch-perf/home"}` (an absolute path: `instance` refuses `~`), then:

```bash
curl -s -X POST -H 'content-type: application/json' -H "origin: $URL" -d '{"args":null}' \
  $URL/api/extensions/pause/actions/state
```

It must say `"paused":true`. If not, stop the instance at once.

## 3. Measure

```bash
node .ultimate/skills/measure-switch/switch.ts $URL 1 <id,id,...> --rounds 2 [--profile ~/switch-perf/a.cpuprofile]
node .ultimate/skills/measure-switch/profile-summary.ts ~/switch-perf/a.cpuprofile
```

- Pass at least two ids (with one, the warm round switches to the conversation already shown). Pick ids with different
  shapes: a long conversation, a lander, @ultimate, one with many subagents
  (`sqlite3 <copy> "select conversation_id, count(*) from entries group by 1 order by 2 desc limit 10"`).
- Round 0 is cold (never shown in the tab), later rounds warm (`store.show` paints the kept replica first).
- `settledMs` and `longMs` are the user-facing numbers; `eventKb` shows what the server sends. A tab keeps one event
  stream and a switch only resubscribes on it, so `streams` (new streams during the switch) should stay 0.
- **What each server event costs while a turn streams or branches work:** `renders.ts` counts per event the main-thread
  time until the next task and the DOM mutations in the transcript during that window:

  ```bash
  node .ultimate/skills/measure-switch/renders.ts $URL <id> --seconds 45          # watch: the live host, read-only
  node .ultimate/skills/measure-switch/renders.ts $URL 1 --send "<prompt>"         # one real turn on a fresh preview
  ```

  A paused copy streams nothing, so watch the live host (the page only reads) or send a prompt on a fresh preview.
  Many mutations on every `ops` event are a reason to look for a part that rebuilds DOM where a keyed list or a
  narrower read would only update what changed; `--profile` shows which functions the time went to.

- Server changes (`server/`, `shared/`) need the instance restarted; web and extension changes hot-reload.

## 4. Compare two trees

One run's warm median moves 30–50 ms with machine load, so compare the two sides interleaved, against one snapshot.
Check the base out in a throwaway detached worktree ([comparing before and after](../../../docs/worktrees.md#comparing-before-and-after);
never `git stash`), copy the paused snapshot once, `cp -r` it to a second home, and start one server per tree, each on
its own home: `instance start {home}` previews your checkout; for the base tree start a scratch server from its
worktree (`docs/running.md`). Confirm both are paused, then:

```bash
node .ultimate/skills/measure-switch/paired.ts $URL_A $URL_B 1 <id,id,...> --runs 4 --rounds 3
```

It runs `switch.ts` against A, then B, `--runs` times, and prints each run's warm median, the warm medians per side
and B minus A. Main against main came out 494 against 504 ms settled: differences of that size are noise.

## 5. Clean up

Stop the instances, remove the worktree and `rm -rf ~/switch-perf`. Nothing from the copy goes into the repository.
