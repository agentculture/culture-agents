# D2 part two acceptance record

Task t28 of the plan `d2-fleet-and-recovery`: part two on 2 real hosts. Hosts
are named by role only. **Host A** is the caller: it submits, steers, cancels
and reads. **Host B** is the member the runs go to. No host name, address, key
or path is recorded here. Each check is **measured** (a number was taken),
**seen** (the behaviour was observed) or **NOT VERIFIED** (not run, with the
reason).

## Hosts

| Role | Architecture | Kernel | Node | OpenShell sandbox |
|------|--------------|--------|------|-------------------|
| Host A | x86_64 | Linux 6.11 | Node 22 | works (Landlock present) |
| Host B | aarch64 (NVIDIA Jetson, JetPack R38) | Linux 6.8 tegra | Node 22.23.5, OpenSSL 3.5.9 | **fails**: the kernel is built without Landlock, and OpenShell needs Landlock ABI v3 |

Both hosts ran the core at the same commit (c64d0e1, control API 3.3), over the
real network between them, with the fleet transport on (TLS 1.3, both sides
authenticated by Ed25519 key against each host's local trust list). The runs
used the stub harness (`CULTURE_AGENTS_HARNESS_STUB=1`), which needs no sandbox.
Run on 2026-11-27.

## Before the checks

| Check | Result | Evidence |
|-------|--------|----------|
| The core's own test suite on host B | **measured** | `npm test`: 859 tests, 851 pass, 0 fail, 8 skipped. An earlier run on the same host had 1 failure (`two cores authenticate each other by key and the caller reads the version`) that did not happen again |
| The arm64 run image builds on host B | **seen** | 603 MB, OpenCode 2.3.2 and the Claude Code bridge inside |
| Each host lists the other | **seen** | `agents agents list` on host A lists host B's node at API 3.3, and host B lists host A's |

## Acceptance checks (stub harness)

| # | Check (t28's acceptance) | Result | Evidence |
|---|--------------------------|--------|----------|
| 1 | A submit from host A runs on host B | **measured** | `agents runs submit --agent <host B's node> --alias demo` returned the run id in 0.72 s; host B records the submitter as host A's member name |
| 2 | It is steered from host A | **measured** | steer accepted in 0.23 s; the run wrote `a.txt`, then `steered.txt` in place of the files it had not written yet |
| 3 | It is cancelled from host A | **measured** | cancel accepted in 0.26 s; the run read `cancelled` 19 ms later |
| 4 | Host A brings the run's commits into its checkout | **measured** | `agents runs result` fetched `runs/<id>` (`a.txt` and `steered.txt`) from the git bundle in 0.30 s, with no shell on host B |
| 5 | With host B halted, every run active on it reads unreachable on host A within the stated seconds, and 0 reads succeed | **measured** | host B's core stopped with SIGSTOP: the first read on host A answered `unreachable` (`no_answer`) at 5.0 s, on 2 tries; after the 15 s silence it answered `not_listed`; `agents runs show` answered the typed `unavailable` and never `succeeded`. The stated bounds are 5 s after a failed call and 16 s after the last announcement (`docs/d2/unreachable-view.md`). After SIGCONT the run read `running` again within about 1 s |
| 6 | A submit to a host whose signal says hold is refused | **seen** | a heat file written to say `hold` on host B: host A's submit was refused `admission_held`, signal `heat`, state `hold`; nothing was queued |
| 7 | A missing signal reads unknown | **seen** | heat file removed on host B: refused `admission_held`, signal `heat`, state `unknown` |
| 8 | A signal that admits lets the submit through | **seen** | host B's real heat governor state, saying admit: the submit was admitted |

Check 5 halted a process, not the network between the hosts. A network
partition was not tested.

## Not verified

| Check | Reason |
|-------|--------|
| A real harness (Claude Code or OpenCode) running a remote run on host B | Host B's kernel has no Landlock, so OpenShell cannot create a sandbox there. An OpenCode remote submit was admitted and then failed at sandbox creation. Fixing it needs a different kernel; an aarch64 host whose kernel has Landlock was not used |
| A real harness on any aarch64 host | the same reason: **ARM with a real harness is NOT VERIFIED** |
| A real harness running a remote run on host A, submitted from host B | not run |
| A model gateway saying `hold` through its `admission` object | the gateway on host B answers `/status` with no `admission` object, so it was not consulted (`docs/d2/remote-runs.md`) |
| A network partition, as against a halted process | not run |
| More than 2 hosts | not run |

## Found during the run (fixed in the same pull request)

- The refusal for a missing heat file carried host B's absolute path to the
  heat file in its message, which host A then showed. The reason now names the
  variable, never the path.
- The text of `agents runs result` joined the stub harness's text lines with no
  separator. The stub now ends each text line with a newline; a real harness's
  text deltas are still joined as they came.
- A run's collected commit could include a `core/node_modules` symlink. The
  ignore pattern was fixed in this repository (`core/node_modules`, no trailing
  slash), so runs started from it no longer collect it.

## The announcement, sentence by sentence

The part two success signal (`c27`) and the announcement (`c1`) of the spec
`docs/specs/2026-11-25-d2-fleet-and-recovery.md`:

| Sentence | Tied to |
|----------|---------|
| Two runs can work in one repository at once | part one, `docs/d2/part-one-acceptance.md` check 1 |
| A restarted core takes back live control of the workers that survived it | part one, check 1 |
| A duplicate submit is answered once | part one, check 2 |
| Work is placed only on a host that can take it | checks 6 to 8 above (the member refuses when its signal says hold or unknown). There is no automatic placement: the caller names the member |
| A halted host is never reported as a success | check 5 above |
| A question a run asks its operator is still waiting after a restart | part one, check 3, stub harness only. Claude Code and OpenCode have no ask path: NOT VERIFIED for them |
| A submit from host A runs on host B and is steered and cancelled from A | checks 1 to 3 above, stub harness |
| With host B halted, every run active on it reads `unknown` on A | check 5 above, with one change: the caller reads **`unreachable`**, a view it computes and never stores. Only host B writes `unknown`, with evidence that the worker is gone (`docs/d2/unreachable-view.md`) |
| A hold signal refuses; a missing signal reads unknown | checks 6 and 7 above, heat signal. The gateway signal: NOT VERIFIED |

## The mock suite

`uv run python -m pytest tests/acceptance/d2 -q -rs` at the same commit on host
A: `17 passed, 4 skipped`. The 4 skips are the opt-in live stage and the ask
path of the two real harnesses, all reported NOT VERIFIED.
