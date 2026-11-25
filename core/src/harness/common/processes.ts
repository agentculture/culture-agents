/**
 * Process listing for the after-cancel checks. The workspace runs `ps` with a marker in the
 * script, so the check's own shell and ps (and the exec helpers above them) can be told apart
 * from what the harness left behind.
 */
import type { Proc } from "./types.js";

export const PS_MARKER = "ca-proc-check";
/** Prints `pid ppid stat args` for every process; zombies are filtered by the parser. */
export const PS_SCRIPT = `: ${PS_MARKER}; ps -eo pid=,ppid=,stat=,args=`;

/** Parse PS_SCRIPT output, dropping zombies and the check's own process chain. */
export function parsePs(stdout: string): Proc[] {
  const rows: (Proc & { stat: string })[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3] as string, args: (m[4] as string).trim() });
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const own = new Set<number>();
  for (const r of rows) {
    if (!r.args.includes(PS_MARKER) && !r.args.startsWith("ps -eo")) continue;
    // The check's shell, its ps, and every ancestor up to (not including) pid 1.
    let cur: (typeof rows)[number] | undefined = r;
    while (cur && cur.pid > 1 && !own.has(cur.pid)) {
      own.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
  }
  return rows.filter((r) => !own.has(r.pid) && !r.stat.startsWith("Z")).map(({ pid, ppid, args }) => ({ pid, ppid, args }));
}

/** Processes in `now` that were not in `baseline` (by pid and command line). */
export function newProcesses(baseline: readonly Proc[], now: readonly Proc[]): Proc[] {
  const seen = new Set(baseline.map((p) => `${p.pid}\0${p.args}`));
  return now.filter((p) => !seen.has(`${p.pid}\0${p.args}`));
}

export const describeProcs = (procs: readonly Proc[]): string =>
  procs.length === 0 ? "none" : procs.map((p) => `${p.pid} ${p.args.slice(0, 120)}`).join("; ");
