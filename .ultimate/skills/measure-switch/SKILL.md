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
node .ultimate/skills/measure-switch/copy-paused.ts $SRC ~/switch-perf/home
```

It reads the source with `VACUUM INTO` (never moves or writes it) and appends a manual pause to the copy's root
`pause.state`, so queued inputs, interrupted runs and automations stay held instead of calling models. Run it from a
checkout whose `pause` extension matches the source's version. Pick the chapter with the shape you need:
`chapters.json` names them; the first chapter is `<home>/state.sqlite`.

## 2. Start a preview on it and confirm the pause

`instance start {home: "~/switch-perf/home"}`, then:

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
- Compare before and after in one session, on one instance home: run main, stop, apply the change, start again on the
  same home. Numbers drift between sessions with machine load; repeat runs and compare medians.
- Server changes (`server/`, `shared/`) need the instance restarted; web and extension changes hot-reload.

## 4. Clean up

Stop the instance and `rm -rf ~/switch-perf`. Nothing from the copy goes into the repository.
