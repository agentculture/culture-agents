# Fleet members (D2 part two, task t22)

Status: built in `core/src/fleet/` (`members.ts`, `announce.ts`, `peers.ts`),
**off by default**, like the transport it runs on (`docs/d2/fleet-transport.md`).
This is Decision 3 of `docs/d2/part-two-design.md`, built as that record
recommends. Remote calls, admission across hosts, the unreachable view and
bundles are not built (tasks t23 to t26).

## What it does

- **Announcing.** A core whose fleet transport is on sends
  `POST /v1/fleet/announce` every 5 seconds to each address in its local
  address list, over the fleet transport, one connection per call. The body is
  `node`, `api_version`, `seq` and `state` (`up` or `leaving`). It carries no
  key material: who sent it is the key the transport authenticated. The reply
  is the answering core's own announcement, so two cores list each other when
  only one knows the other's address.
- **Listing.** A member is listed only after an announcement arrives from a key
  in the trust list, and only under the node name the trust list gives that
  key. Nothing else adds an entry: not the trust list and not the address
  list. An address with no live core behind it is never listed. The list is
  read with `agents agents list` (text, or `--json` under `fleet`), on the
  control socket as `GET /v1/fleet/members` (API 3.1), and by authenticated
  members over the fleet transport.
- **Unique node names (c40).** An announcement is refused with HTTP 409 when the
  node name it claims is not the one the trust list gives its key, is this
  core's own node name, or is still held by another listed key. The last case
  arises when the operator replaces a trust entry while the old key's core
  still runs: the name frees once that core leaves or goes silent. The refusal
  is reported to the operator in the core's log, once a minute per claim at
  most, and in `refused` in the member list, which `agents agents list` prints.
  The refused core logs the 409 too.
- **Dropping.** A member is dropped at once when it announces `leaving`, which
  a core does on a clean stop (SIGTERM or SIGINT) to every address in its own
  list, waiting at most 1 second. A member silent for more than 15 seconds is
  dropped: a read never shows it, and a sweep every second logs the drop. A
  core that knew a stopping core only from its replies drops it by silence.
- **Clocks.** Silence is measured on the reading core's monotonic clock. The
  sender's clock is never read, and no timestamp from one host is compared with
  a clock on another (c42). `heard_ms_ago` in the list is a duration.
- **Bounded.** Each announcement call times out after 5 seconds, and each side
  reads at most 16 KiB of an announcement or its reply. The address list holds
  at most 64 addresses. The refusal report keeps the 32 newest refusals and
  forgets one not repeated for an hour.

## The address list

`${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/peers.json`, beside the
trust list, is a local, untracked JSON array:

```json
["127.0.0.1:7443"]
```

- Entries are `"<ip>:<port>"` or `"[<ipv6>]:<port>"`. A host name is refused,
  because nothing here resolves a name, so no name can redirect a call. The
  port is 1 to 65535.
- It is configuration, not membership. It is the only place a core keeps an
  address, and it is never tracked: a test (`tests/test_fleet_no_host_list.py`)
  fails if a tracked file is named `peers.json` or `trust.json`, or holds an
  address that names a host.
- A missing file announces to nobody, and the core still hears the cores that
  announce to it. An invalid file stops the core at start (exit 2), like an
  invalid trust list. If the file turns invalid while the core runs, the core
  announces to nobody and logs why until the file is fixed. The core reads the
  file again for every round, so no restart is needed.

## Detection times

The bounds are the design record's table. The core tests hold them with an
injected clock. The acceptance tests run two real cores and use generous
wall-clock bounds.

| Detection | Stated bound | Held by |
| --- | --- | --- |
| A core that stops cleanly leaves the list | within 1 s | `core/test/fleet/announce.test.ts` (the list is empty before the stop returns); `tests/acceptance/d2/test_fleet_members.py` with real processes |
| A core that dies or halts leaves the list | within 16 s (15 s of silence plus a 1 s sweep) | `core/test/fleet/members.test.ts` and `announce.test.ts` (listed at 15 s, gone at 15.001 s, injected clock); the acceptance test kills a real core with SIGKILL |
| The announcing core sees the core it announces to go silent | within 16 s | `announce.test.ts` |
| One announcement to an unreachable member fails | within 5 s | the call timeout, `FLEET_TIMEOUT_MS` |
| A returning core is listed again | at its next announcement (5 s) | `members.test.ts`, `announce.test.ts` |

## The key

The member list adds no secret. The key handling is t21's: the key is read once
at start from `CULTURE_AGENTS_FLEET_KEY` and deleted from the core's
environment before any socket listens. It still stays readable in
`/proc/<core pid>/environ` to every process of the same user while the core
runs (`docs/d2/fleet-transport.md`).

## What was measured, and what was not

- **Measured on loopback, on one machine:** listing after one announcement in
  both directions, leaving on a clean stop, drop by silence (injected clock,
  and a real SIGKILL), the three conflict refusals and their reports, the
  untrusted key refused in the handshake, the size cap, and the CLI's text and
  `--json` output.
- **NOT VERIFIED until t28 runs on two real hosts:** latency, loss, NAT and
  firewalls, and whether 15 seconds of silence drops live members by mistake on
  a real link. A core frozen with SIGSTOP was not run here; the probe in
  `spikes/d2-part-two/` ran that case.
