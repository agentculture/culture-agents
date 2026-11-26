# Concurrent fetches into one repository (t8)

The challenge pass (spec s44, s50) left one question open. When two runs in one
repository hand their results back at the same moment, both run `git fetch`
into the same host repository. How does git behave then, given packed-refs?
t8 checked it.

## What each fetch writes

Each result returns with one non-forced refspec,
`refs/heads/runs/<id>:refs/heads/runs/<id>`, using `--no-tags` and
`--no-write-fetch-head` and with `gc.auto=0` set. Both the sandbox path
(`core/src/sandbox/worktree.ts` `collect`) and the stub path
(`core/src/harness/stub/workspace.ts`) do this.

- A fetch updates its ref inside a ref transaction. The transaction locks only
  that ref's own lock file (`refs/heads/runs/<id>.lock`). Two runs have
  different ids, so they never take the same ref lock.
- A ref update does not rewrite `packed-refs`. It writes a loose ref that
  shadows the packed entry. Git rewrites `packed-refs` only when a ref is
  deleted or when `pack-refs` or `gc` runs. A fetch never deletes a ref, and
  `gc.auto=0` stops a fetch from starting `gc`.
- `FETCH_HEAD` is not written.
- New objects go into `objects/` under temporary names and are then renamed,
  so two fetches can store objects at the same time.

The one path that does lock `packed-refs` is the sandbox collect's
`git update-ref -d` after a failed ancestry check. That command takes the
`packed-refs` lock, and git waits for the lock (`core.packedRefsTimeout`,
default 1 s) rather than failing at once.

## Measured

All measurements used git 2.43.0 in the task sandbox.

- **Test** (`core/test/runs/isolation.test.ts`, "concurrent-fetch check"). Six
  stub workspaces on one repository run six rounds. In each round every
  workspace commits, and then all six `collect()` calls run together under
  `Promise.all`. The host's refs are packed (`git pack-refs --all`) before
  rounds 0, 2 and 4, so most fetches update refs that sit in `packed-refs`.
  Every fetch succeeded. Every `runs/<id>` equals its own workspace's HEAD and
  holds only its own files. `git fsck` is clean. The host checkout, index,
  HEAD and `main` are byte-identical before and after.
- **Before the test (not committed).** A shell loop ran 8 clones × 20 rounds
  of simultaneous fetches, with `pack-refs` every 5 rounds: no error and
  `fsck` clean. A second loop ran 8 clones × 10 rounds in which half of the
  clones delete their `runs/<id>` ref with `update-ref -d` (which locks
  `packed-refs`) and fetch it again, while the other half fetch: no error, all
  refs correct, `fsck` clean.

## Not covered

- An operator who runs `git gc` or `git pack-refs` by hand during a fetch
  competes for the `packed-refs` lock. Git waits for that lock (see above), but
  this case was not measured.
- The sandbox path fetches over OpenShell SSH. It was not run here (no
  gateway). Its host-side git commands are the same fetch with the same
  refspec, plus the fsck options.
