/**
 * What the worker does when the harness raises or drops a question (split from run-loop.ts, which is
 * at its line cap). A raised question is appended durably as `run.question` before the run waits for
 * it; a withdrawn one is logged as a diagnostic `run.output` line (no 3.0 event kind fits; the line
 * is read back by store/questions.ts) and leaves the pending set, and the deadline resumes when none
 * is left.
 */
import type { RunEvent, RunState } from "../contract/index.js";
import type { EventInput } from "../store/event-log.js";
import { WITHDRAWN_PREFIX } from "../store/questions.js";
import type { AskedQuestion } from "./driver.js";
import type { QuestionDesk } from "./questions.js";

export interface AskingHost {
  desk: QuestionDesk;
  clock: () => number;
  state: () => RunState | null;
  /** queued -> running, for a question raised before the harness reported a start. */
  start: (reason: string) => void;
  append: (input: EventInput, durable?: boolean) => RunEvent | null;
  checkClock: () => void;
}

const diagnostic = (host: AskingHost, text: string): void => {
  host.append({ kind: "run.output", data: { channel: "diagnostic", text } });
};

export function raiseQuestion(host: AskingHost, asked: AskedQuestion): void {
  if (host.state() === "queued") host.start("the harness asked a question before reporting a start");
  if (host.state() !== "running") return diagnostic(host, "the harness asked a question while the run was stopping; it is not recorded");
  const question = host.desk.ask(asked, host.clock());
  host.append({ kind: "run.question", data: { question } }, true);
  host.checkClock();
}

export function withdrawQuestion(host: AskingHost, ref: string): void {
  const id = host.desk.withdraw(ref, host.clock());
  if (id === null) return diagnostic(host, "the harness withdrew a question the run does not hold; ignored");
  diagnostic(host, `${WITHDRAWN_PREFIX}${id}`);
  host.checkClock();
}
