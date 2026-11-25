/**
 * Process listing for the after-cancel checks. The script prints its own shell pid on the first
 * line, then `ps`. The check's own processes are told apart from what the harness left behind by
 * that pid alone, never by what a command line looks like: a harness child controls its own
 * argv, so anything matched by text is something it could imitate to stay out of the list.
 */
import type { Proc } from "./types.js";

/** Tag of the first output line, which carries the check's own shell pid. */
export const PS_SELF = "ca-self";
/** Prints `ca-self <shell pid>`, then `pid ppid stat args` for every process; zombies are filtered by the parser. */
export const PS_SCRIPT = `echo "${PS_SELF} $$"; ps -eo pid=,ppid=,stat=,args=`;

/**
 * Parse PS_SCRIPT output, dropping zombies and the check's own processes: the shell whose pid
 * the first line reports, its descendants (the `ps`), and its ancestors up to (not including)
 * pid 1 (the exec helpers that started it). Parent links come from the kernel, so no harness
 * process can place itself in that chain. Throws when the first line is not the pid line.
 */
export function parsePs(stdout: string): Proc[] {
  const lines = stdout.split("\n");
  const self = new RegExp(String.raw`^${PS_SELF} (\d+)\s*$`).exec(lines[0] ?? "");
  if (!self) throw new Error("the process listing did not report its own pid");
  const rows: (Proc & { stat: string })[] = [];
  for (const line of lines.slice(1)) {
    // The arguments start at a non-space character, so the space before them is matched one way only.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:\S.*)?)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3] as string, args: (m[4] as string).trim() });
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const own = new Set<number>([Number(self[1])]);
  for (let cur = byPid.get(Number(self[1])); cur && cur.ppid > 1 && !own.has(cur.ppid); cur = byPid.get(cur.ppid)) own.add(cur.ppid);
  const isOwn = (row: (typeof rows)[number]): boolean => {
    // Walk up from the row; it is the check's when the walk reaches the check's shell.
    const seen = new Set<number>();
    for (let cur: (typeof rows)[number] | undefined = row; cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      if (cur.pid === Number(self[1])) return true;
      seen.add(cur.pid);
    }
    return false;
  };
  return rows.filter((r) => !own.has(r.pid) && !isOwn(r) && !r.stat.startsWith("Z")).map(({ pid, ppid, args }) => ({ pid, ppid, args }));
}

/** Processes in `now` that were not in `baseline` (by pid and command line). */
export function newProcesses(baseline: readonly Proc[], now: readonly Proc[]): Proc[] {
  const seen = new Set(baseline.map((p) => `${p.pid}\0${p.args}`));
  return now.filter((p) => !seen.has(`${p.pid}\0${p.args}`));
}

export const describeProcs = (procs: readonly Proc[]): string =>
  procs.length === 0 ? "none" : procs.map((p) => `${p.pid} ${p.args.slice(0, 120)}`).join("; ");
