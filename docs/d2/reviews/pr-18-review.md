# PR #18 review: D2 part two, cores on more than one host (API 3.3)

**Verdict: approve-with-comments, at 6735e5b (reviewed 2026-11-27, version 0.17.0).** This assumes CI on 6735e5b comes back green. That run is still pending, so it is not verified.

## The diff

- The web diff and the worktree diff of `main...runs/d2-fleet` match file for file. Both are 197 files, +11905 −238, head 6735e5b, base 2c445e4.
- The size by area:

  | Area | Files | Lines |
  |---|---|---|
  | `core/src` | 35 | +2497 −20 |
  | `core/test` | 28 | +2550 −74 |
  | `contract` | 62 | +1424 −17 |
  | `culture_agents` | 11 | +561 −51 |
  | `tests` | 20 | +1352 −29 |
  | `docs` | 15 | +2265 |
  | `spikes` | 12 | +1015 |

- **No new dependencies:**
  - `core/package.json` changes the version (0.17.0) and adds the `culture-agents-fleet` bin;
  - `core/package-lock.json` mirrors that;
  - `pyproject.toml` changes the version and adds 4 schema force-includes;
  - `uv.lock` changes the version only.
- There are no binaries.

## 1. Correctness findings (ranked)

1. **should: the PR body is stale against the tip.**
   - The "Checks" section names 7e65fff and 2119 Python tests. The tip is 6735e5b, and 2121 tests pass.
   - The body does not mention the two SonarCloud commits, 5b7d0fc and 6735e5b.
   - It also does not mention the user-visible change in 6735e5b: `--deadline` together with `--deadline-in` is no longer refused.
2. **should: `culture_agents/cli/_commands/runs.py` (`runs_submit`, hunk "deadline_in = deadline if isinstance(deadline, int)") now picks the later of the two deadline flags.**
   - It no longer refuses giving both. On a remote run, `--deadline <time> --deadline-in 600` drops `--deadline` without a word, where the old code exited 1.
   - The help text and the CHANGELOG say so.
   - `--deadline-in` now shows the metavar `DEADLINE` in the help, not seconds (nit).
3. **should (carried from the first review, listed in the PR body as follow-up):**
   - a result over 1 MiB reads as `no_answer`;
   - steer and cancel idempotency keys are not namespaced per member (`core/src/runs/service.ts` `keyed`);
   - any host that can reach the listen port can hold the 64 handshake slots (`core/src/fleet/transport.ts`);
   - a logs page of 50 events can pass the 8 MiB cap (`core/src/daemon/fleet-routes.ts`);
   - run ownership is by trust-list node name, not by key (`core/src/fleet/serve-runs.ts` `ownRun`).
4. **nit: `culture_agents/cli/_remote.py` `checkout_head` accepts only a 40-hex SHA.** In a SHA-256 repository the default base silently becomes none, so the run starts from the member's HEAD.

Fixed in this PR during review and CI; each has a test:

- `core/src/fleet/cert.ts`: the serial was a non-minimal DER INTEGER for about 1 key in 256, so OpenSSL refused the certificate.
- `core/src/fleet/serve-runs.ts`: the 5 s socket idle limit cut off the 60 s bundle (`allowReplyFor`).
- `runs_result`: it fetched any branch the member named.
- 11 SonarCloud findings.

## 2. PR text against the tip

See finding 1.

The acceptance record `docs/d2/part-two-acceptance.md` matches the dry-run notes:

- submit 0.72 s, steer 0.23 s, cancel 0.26 s and result 0.30 s;
- `no_answer` at 5.0 s;
- `admission_held` on hold and on unknown.

## 3. Compat and API notes for callers

- The API goes from 3.0 to 3.3, and each step adds routes and files only.
- `CLIENT_API_VERSION` is 3.3.
- The fleet is off unless `CULTURE_AGENTS_FLEET_LISTEN` is set.
- `agents runs submit` keeps its flags. The one behaviour change is finding 2.
- Idempotency conflict errors now show the key without its member namespace (`core/src/runs/keys.ts` `shown`). That is safe because the key pattern `^[A-Za-z0-9._:-]{1,128}$` holds no `/`.

## 4. Test coverage

**Covered well:**

- the TLS trust both ways, and the captured bytes;
- the member list;
- remote submit, steer and cancel across two real cores;
- the unreachable view under SIGSTOP;
- bundle ownership;
- admission on hold and on unknown;
- the minimal-DER serial;
- the lifted idle limit;
- the refused foreign branch.

**Gaps:**

- No test makes a bundle take longer than 5 s through `serve-runs`. The lift is tested at the transport level only.
- No test gives both deadline flags.
- No test covers a result over 1 MiB.

## 5. Security and robustness notes

- The transport is TLS 1.3 only, with no system root certificates. The leaf key fingerprint is checked against a trust list read on each connection, and the node name is bound to the key.
- `ownRun` gates every remote run route.
- Run ids are checked against the schema, and node names are `[a-z0-9]{1,32}`, so the CLI's `is_remote` split on the first `-` is sound.
- A truncated response in `fleetCall` surfaces as an error or ECLOSED, never as a short body.
- The open robustness item is the handshake-slot exhaustion in finding 3.

## Measured, seen, never verified

**Measured by this review at 6735e5b:**

- core `npm test`: 861 tests, 853 pass, 0 fail, 8 skipped;
- Python `uv run pytest -n auto`: 2121 passed, 13 skipped;
- `teken cli doctor --strict`: rc 0;
- 0 unparseable certificates out of 3000 fresh keys, after the fix.

**Seen:**

- CI on 5b7d0fc: every check passed except the open-issues check, and the SonarCloud gate was OK with 2 open issues;
- the t28 measurements on 2 real hosts, from the dry run earlier in this session.

**Never verified:**

- CI and the SonarCloud gate on 6735e5b (still pending);
- that SonarCloud accepts the S9382 fix;
- a real harness across hosts, and any real harness on aarch64;
- a network partition;
- a gateway `hold`.

## Resolution (after this review)

Every finding above was then fixed on the pull request's branch before the merge (the owner asked for all of
them): the deadline flags are refused together again at parse time; run ownership is by key
(`submitter.key`); steer and cancel keys are held per member; one address holds at most 8 fleet
connections; a result is read under 8 MiB and a member cuts an events page to 4 MiB; a too-large or
untrusted answer is `unavailable` saying so; a revoked member leaves the list at once; a SHA-256 checkout
is refused; the unreadable-bundle message and the remote `--limit` help are corrected; the bundle route's
idle-limit lift has a wiring test. Commits `6716c35` and `1fc6795`; pull request 18 was squash merged as
`6cd81ca` with CI green and SonarCloud at 0 open issues.
