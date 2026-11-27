# Can a dying core overlap a new core's reattach? (t9, parked question)

**Question.** A dying core may finish asynchronous work after it releases the
state-directory lock, while a new core already reattaches to the same worker.

**Finding (from reading the code; no overlap was provoked or measured).**
`daemon/main.ts` stops the HTTP server (`daemon.stop()`), then releases the lock.
What can still run in the old process after that:

- `runs.reclaim()` started by the timer, if one was in flight. It deletes sandboxes
  of *finished* runs only and never talks to a worker. Overlap with a reattach is
  harmless; two cores deleting the same sandbox is an existing, idempotent case.
- A reattach ping in flight (new in t9). It only reads: a ping, then a map insert in
  the dying process. It writes nothing to the run.
- A steer or cancel the old core already sent to a worker. The worker is the log's
  only writer while it lives and handles each control connection in turn, so a late
  action from the old core and an action from the new core are both appended once,
  in order. The log is not corrupted. Which of two competing actions lands first is
  not decided by any rule.
- `settleOrphan` (the core appending `unknown`) is synchronous and runs only for a
  run with no live worker, so it cannot interleave with a worker's writes.

**Conclusion.** No fencing rule is needed for the log. The worker's single-writer
rule and the read-only reattach cover it. Not covered: two competing control actions
from an old and a new core have no defined order, and SIGKILL (the case the tests
exercise) leaves no late work at all because the old process is gone.

**Related behaviour chosen in t9.** A live worker whose control socket does not
answer is reported `unknown` by the new core without appending to its log (the worker
may still be the writer) and is never signalled. If that worker later writes a
terminal event, the log's state wins on the next read.
