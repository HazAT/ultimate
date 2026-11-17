// Fast tests start no processes, so none has a process group of its own to signal. A fake child with a made-up pid can
// still reach a real `process.kill(-pid)`: `-1` is every process of the user (#562356: a fake `pid: 1` ended a desktop
// session three times). So the fast suite cannot signal a group at all, whatever the code under test does; a test that
// wants to see the call spies on `process.kill` over this.
const kill = process.kill.bind(process)
process.kill = (pid: number, signal?: string | number) => {
  if (!(pid > 1)) throw new Error(`A fast test tried process.kill(${pid}, ${signal})`)
  return kill(pid, signal)
}
