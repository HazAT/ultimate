# Resource safety audit: can Ultimate catch a runaway worker?

A read-only audit of Ultimate's safeguards against an agent-launched workload that exhausts the host's memory. It was
prompted by a real incident: a worker ran a PyTorch/MPS benchmark inside one of Ultimate's projects, the machine went
into severe memory pressure and had to be force-quit, and the workload was re-issued by automatic recovery before
anyone intervened.

Scope and limits: this audit read the implementation, ran bounded probes through the normal tools (no memory-heavy
reproduction, no unbounded stress), and read the incident's durable record read-only. It changed no production code and
restarted nothing. Where a statement rests on reading code rather than on an observed behaviour, it says so.

## 1. Executive summary

1. Ultimate measures host memory in exactly one place, `server/system.ts:121-122` (`totalmem`, `freemem`), and never
   acts on it: it feeds a text colour in the Info panel (`extensions/info/web.tsx:71`). Nothing samples memory per
   process, per process tree, per worker or per task, and nothing reads swap, memory pressure, `vm_stat` or load.
2. The agent's `bash` tool is **outside** the process-group machinery Ultimate otherwise trusts. Lander checks,
   automation scripts and previews spawn through `lib/process-group.ts` (pid file, start-time identity, sweep); the tool
   a worker runs a benchmark with spawns a detached shell with no pid file and no registry (`dist/env/node.js:742-749`).
3. A timeout kills the whole group, but a *successful* call kills nothing. Bounded probes confirmed both: a call whose
   timeout expired left no survivors; a child that outlived its call was still running in the following tool call.
4. So a heavy job that is backgrounded inside a shell is invisible to Ultimate from the moment the call returns: no pid
   file, no sweep, no owner. That is the shape of the incident.
5. There is no admission control and no concurrency cap on either path: subagent starts and bash calls launch
   unconditionally (`extensions/subagents/server.ts:940-1010`).
6. Recovery is automatic and ungated. On the next start of a project, `harness.resume()` (`server/main.ts:217`) resumes
   the interrupted branch, the model is told its tool "was interrupted and may have partially run", and it re-decides —
   in the incident, re-issuing the same workload repeatedly within minutes.
7. A resource kill is indistinguishable from success at the model boundary: a process ended by a signal inside a
   pipeline can still produce a successful tool result, because the last command of the pipeline exited 0.
8. Nothing persists resource data. The trace table records timing only, so after the fact no spike can be attributed to
   a call, a task or a worker.
9. The OS did the guarding. Ultimate was a bystander with no veto.
10. The process-group machinery Ultimate already has is good — TERM→KILL drain, start-time identity, EPERM handling,
    sweeps — and is simply not applied to the one path that matters. The fix is three small changes, not a scheduler.

## 2. Current resource-management architecture

The lifecycle, as implemented (not as it reads in the docs):

```
coordinator (a conversation)
  └─ subagent start ─────────────► child conversation, own worktree, independent lifetime
        └─ tool call ─────────────► coding-tools wraps Pi's bash tool (extensions/coding-tools/server.ts:286-355)
              └─ spawn ──────────► detached shell, no pid file, not in any registry (dist/env/node.js:742-749)
                    └─ timeout? ──► kill(-pgid, SIGKILL)  … only when a timeout or an abort fires
```

Two separate spawn universes exist:

- **Managed** (`lib/process-group.ts`): pid file with the process start time as identity, `detached: true`, TERM then
  KILL after a grace period, a sweep of leftovers on start. Used by lander checks (`extensions/workspaces/lander.ts`),
  automation scripts (`extensions/automations/supervisor.ts`), and isolate setup (`extensions/workspaces/setup.ts`,
  though there with a plain `execFile`, so `pnpm install`'s grandchildren are not covered).
- **Unmanaged** (Pi's bash tool): what an agent's `bash` call actually runs. Detached, so children survive their parent,
  but with nothing that could find them later.

Ownership therefore is: the *conversation's* task record owns a tool call; the shell it spawns owns its own process
group; nothing owns a backgrounded grandchild. Process-tree tracking exists only where `runGroup` was used.

## 3. Safeguard coverage matrix

"Effective?" means: does it prevent or detect a memory-exhausting workload? `VERIFIED` = observed, `CODE` = read only.

| # | Safeguard | Exists? | Where? | Effective? | Gap | Pri |
|---|---|---|---|---|---|---|
| A1 | Host free/total memory read | yes | `server/system.ts:121-122` | no — display only | never consulted, not persisted | P2 |
| A2 | Per-process / per-tree RSS | **no** | — | no | nothing reads RSS; no attribution to call, task or worker | P1 |
| A3 | Aggregate across concurrent workers | **no** | — | no | no counter anywhere | P1 |
| A4 | Swap / pressure / `vm_stat` / jetsam | **no** | — | no | no code path samples any of them | P1 |
| A5 | CPU / load for decisions | **no** | `server/system.ts:98` | no | `cpus()` is display only; load never read | P3 |
| A6 | Memory admission control | **no** | — | no | `start` and `bash` never ask | P1 |
| B1 | Max concurrent subagents | **no** | `extensions/subagents/server.ts:940-1010` | no | `background` is a waiting style, not a quota | P2 |
| B2 | Max concurrent bash calls | **no** | — | no | no semaphore, no queue | P2 |
| B3 | Deferral instead of launch | partial | `harness.hold()`, `extensions/pause/server.ts:133-135` | only for pause/rate-limit | no resource-shaped caller | P2 |
| C1 | Wall-clock timeout on bash | yes | `extensions/coding-tools/server.ts:45-50` | time only, 600 s default | a call may request far more; a pipeline can mask the exit code | P1 |
| C2 | Timeout kills the process tree | yes | `dist/env/node.js:214-241,637-640` | yes, for in-group members | VERIFIED: a timed-out call left no survivors | — |
| C3 | Group kill on *normal* completion | **no** | `dist/env/node.js:672-679` | no | VERIFIED: a child outlived its finished call | **P0** |
| C4 | Escaped (`setsid`) children killed | **no** | pinned by `test/e2e/process-group.test.ts:260-291` | no | known and documented, not handled | P3 |
| C5 | Lander check timeouts | yes | `extensions/workspaces/lander.ts:120-125,185-214` | yes | stall 2 min / total 10 min, whole group killed | — |
| C6 | Isolate setup timeout kills tree | partial | `extensions/workspaces/setup.ts:18-25` | no | plain `execFile`: grandchildren survive | P2 |
| C7 | Automation script timeout + cleanup | yes | `extensions/automations/supervisor.ts:430-450,575` | yes | pid file, TERM→KILL | — |
| C8 | Graceful shutdown kills in-flight shells | yes | `server/harness.ts:293` | yes, on SIGINT/SIGTERM only | a crash runs none of it | P0 |
| C9 | Retry respects a timeout | n/a | `extensions/watchdog/server.ts:31-32` | — | retries cover provider errors, not re-issued commands | P2 |
| D1 | Normal completion cleans the tree | **no** | see C3 | no | the incident's mechanism | P0 |
| D2 | Worker failure kills its tree | yes | `extensions/subagents/server.ts:1068-1166` | yes for the current call | earlier backgrounded children are unreachable | P1 |
| D3 | Coordinator stop kills children | **no**, by design | `extensions/subagents/README.md` | — | only concluding a child aborts its work | P2 |
| D4 | Operator interrupt kills the tree | yes | `extensions/coding-tools/server.ts:190-217` | yes | — | — |
| D5 | Terminal/process killed → children reaped | **no** | — | no | detached children are reparented and keep running | P0 |
| D6 | Orphan sweep after a crash | partial | lander + automation pid files only | for those two kinds | agent bash, isolate setup, previews: never | P0 |
| D7 | Pid identity / reuse safety | yes | `lib/process-group.ts:28-50,222-250` | yes where used | Darwin `ps lstart` resolves to a second | — |
| E1 | Durable record of what ran | yes | `state.sqlite` tasks/entries | yes | no resource fields | — |
| E2 | Resource telemetry persisted | **no** | trace schema: timing only | no | nothing to attribute a spike to | P1 |
| E3 | Resource failures distinguishable | **no** | `extensions/watchdog/server.ts:53-59` | no | a kill arrives as an exit code, or as success | P1 |
| E4 | Automatic recovery re-runs work | yes | `server/main.ts:217`, `restartLimit` 5 | works — including for unsafe work | `bash` is not replay-safe, so the model re-decides | P1 |
| E5 | Human gate before re-running dangerous work | **no** | — | no | repeated re-issues within minutes | P1 |
| E6 | Task held on resource grounds | no | `extensions/pause/README.md` | — | `PauseApi` is user-only; no guard calls it | P1 |

## 4. What the incident record showed

Relative timing, from the project's durable record (exact timestamps and identifiers deliberately omitted):

| When | What |
|---|---|
| T+0 | A branch starts and reads the benchmark code. |
| T+6 to T+20 min | The benchmark is launched in the background and polled until it reports finished. |
| T+20 min | A second, heavier inference call starts **in the foreground** with a 600 s timeout. |
| ~T+27 min | The machine is rebooted (hard). |
| T+31 min | Ultimate restarts for the project; recovery resumes the branch and tells the model its tool "was interrupted and may have partially run". |
| T+31 to T+34 min | The model re-issues the same workload three times, within three minutes, with no gate. |
| T+34 min | One attempt ends with a signal (`Killed: 9`) after ~150 s; the tool result is reported as **success**, because the pipeline's last command exited 0. |
| ~T+35 min | The host is force-quit; the durable record is left with tasks `waiting` and `running`. |

Which safeguards applied: the wall-clock timeout was on and never fired (it bounds a single call, not a backgrounded
job); timeout→group-kill never triggered (no timeout, no abort); group cleanup on normal completion is absent; no pid
file existed that a sweep could have found; no concurrency limit existed; no memory observer existed; graceful shutdown
never ran (the machine went down); recovery ran and repeated the work; no human was asked.

## 5. Critical gaps

1. **A backgrounded child outlives its call, untracked** (C3, D1, D6). Nothing can find it afterwards, not even a stop.
2. **Nothing is reaped after a crash** (D5). Detached children reparent and keep running.
3. **A signalled end can look like success** (E3, C1). The model's only feedback is an exit code from the pipeline.
4. **Recovery repeats work without a gate** (E4, E5).
5. **No attribution** (A2, A3, E2): no per-call, per-tree or aggregate memory, and nothing persisted to reason from later.
6. **No admission control** (A6, B1, B2): work starts regardless of what the machine is doing.

## 6. Recommended minimal architecture changes

Reuse what exists; add no second orchestration system.

**R1 — Process ownership for the agent shell.** Spawn the agent's bash through the same machinery lander checks and
automations already use: pid file with start-time identity, drain the whole group when the leader exits normally, and
sweep that directory on start. Effort: 1–2 days (an upstream patch plus plumbing and tests; the repository already
carries a Pi patch, so the precedent exists). Prevents: backgrounded workloads outliving their call; orphans after a
crash; the incident's mechanism.

*R1's limit, stated plainly:* it stops a backgrounded workload from outliving its call and stops orphans surviving a
crash. It does **not** stop a single long foreground call — a legitimate heavy inference inside one tool call is still
bounded only by the wall-clock timeout. R2 covers that case.

**R2 — A resource guard.** One sampler reads free memory, swap and the tracked trees' resident memory; above a soft
threshold it warns on the active call's card, above a hard threshold it cancels the largest consumer through the
existing abort → group-SIGKILL path and holds new work. Effort: 1–2 days. Prevents: an exhaustion that happens inside a
legitimate foreground call.

**R3 — Attribution in the tool result.** Record each call's duration, sampled peak RSS and whether it ended by signal;
report a signalled end as an error even when a pipeline masks the exit code. Effort: small. Prevents: a kill reading as
success, and gives the next audit real numbers.

**R4 (later) — Admission control.** Once R1–R3 exist, park rather than launch new calls and subagent starts while R2's
hard threshold holds, with a card explaining why. Effort: ~1 day.

**R5 — not worth doing:** cgroup emulation on macOS, per-process `setrlimit` caps, a second scheduler, a general metrics
store, or rewriting subagents as separate processes. Also not worth doing: making `bash` replay-safe — the fix for
recovery is a gate, not a replay policy.

**One decision to make explicit:** whether an agent's bash call may launch a persistent background job at all. Draining
every group on normal exit is the safe default, but it changes legitimate daemon and dev-server commands. The cleaner
answer is a managed background-execution mechanism (owned, listed, stoppable, swept) rather than unrestricted `&` and
`nohup`.

## 7. Prioritized implementation plan

| Order | Item | Effort | Prevents |
|---|---|---|---|
| 1 | **R1** ownership: pid file + drain on normal exit + sweep | 1–2 days | backgrounded workloads outliving their call; post-crash orphans |
| 2 | **R3** peak RSS + "ended by signal" as an error | 0.5 day | a kill reading as success; no attribution |
| 3 | **R2** resource guard: sample, warn, cancel, hold | 1–2 days | exhaustion inside a legitimate long call |
| 4 | **R4** admission control under a hard threshold | ~1 day | several heavy workloads running together |

## 8. Test and verification strategy

All bounded; no unbounded memory stress, no real benchmark rerun.

- **Ownership:** a call that backgrounds a child must leave nothing behind after it returns; a killed supervisor must
  leave nothing behind after the next start sweeps. Probe with short self-terminating sleeps.
- **Signalled end:** a call whose child is killed must produce an error result, including when a pipeline's last command
  exits 0.
- **Cancellation:** a child that ignores SIGTERM must still die at the end of the grace period; a child that escapes the
  group is documented as out of scope rather than implied to be covered.
- **Guard:** with mocked metrics, a soft threshold warns, a hard threshold cancels the largest tree and holds new work;
  a task parked this way resumes only after the pressure clears, and never automatically re-runs the cancelled command.
- **Recovery:** an interrupted heavy command must be reported as interrupted, and re-running it must be a decision with
  a visible gate, not an automatic replay.
- **macOS specifics:** swap and pressure readings must be sampled the same way on Linux and macOS, with the platform's
  enforcement limits (no cgroups) written down rather than emulated.

## 9. Answers

**Q1 — Could Ultimate have prevented the incident with its existing safeguards?** No. The only tripwire is wall-clock on
a single call, and a backgrounded workload is not that call; group-kill on completion does not exist; no pid file could
have been swept; no memory observer existed. What Ultimate did do was resume the branch and let the model re-issue the
workload.

**Q2 — Can Ultimate currently detect that one of its workers is exhausting host memory?** No. There is no per-tree or
aggregate measurement, no pressure sampling, no persisted resource data and no classification of resource failures.

**Q3 — What happens to processes when the coordinator or the terminal is terminated?** Stopping a running call kills
its group; graceful shutdown kills in-flight groups. A crash or a force-quit kills nothing: the shells are detached,
their children are reparented, and only lander and automation pid files are ever swept. Children started before the
current call are unreachable even by an explicit stop. Stopping a coordinator does not stop its subagents, by design.

**Q4 — Can automatic recovery repeat an unsafe workload?** Yes. Resume is ungated and runs at every project start. A
tool call is not replayed, but the model is told it was interrupted and re-decides, which is what happened.

**Q5 — What is the smallest set of changes that makes autonomous execution safe on a memory-constrained host?** Put the
agent shell inside the process-group machinery that already exists (R1); report what a call actually consumed and
whether it was killed (R3); add one guard that samples pressure, warns, cancels the largest consumer and holds new work
above a hard threshold (R2). Admission control (R4) can follow once those exist.

## 10. What could not be established

Peak memory of the workload, whether unified (MPS) memory or anonymous pages were the constraint, and which of the two
heavy calls drove the machine into pressure are **not** recoverable: the durable stores carry task/entry text and timing
only, and no sampler existed. Whether the final stop was a force-quit or a crash looks the same in the record. The
signal that ended the retry is a SIGKILL; identifying macOS jetsam as its sender is an **inference** the record cannot
confirm.
