# D2 part two design record

Task t20 of the plan `docs/plans/2026-11-26-d2-fleet-and-recovery.md`. This is
a decision document for the owner and a human gate: no part two code task
starts until the section [Owner approval](#owner-approval) says approved.
Nothing here is built. Every behaviour below is **(planned, part two)**.

It decides what tasks t21 to t26 need decided: how two cores connect, where a
core's key lives, how a core announces itself and is dropped, the number of
seconds for each detection, what makes two checkouts the same repository, and
which commit a remote run starts from. The spec already settled several
things, and this record does not reopen them: key pairs rather than a shared
secret (c37), the operator adds a new member's public key on each existing
host, revocation is removing that key, effective on the next connection,
membership travels directly between cores, never over the chat mesh, and one
operating-system user per host.

Hosts are named by role only: host A and host B. The only example node name
is `thor`. No host name, address or host list is written here or in the
probes. The one address that appears is the loopback address the probes ran
on.

## Summary of recommendations

| Decision | Recommendation | Built by |
| --- | --- | --- |
| 1. Transport | TLS 1.3 from `node:tls`, both sides authenticated. Each core presents a self-signed certificate derived in memory from its Ed25519 key. Each core trusts exactly the member certificates in its own trust list. No session tickets. The control API is HTTP over that socket. | t21 |
| 2. Private key | Injected by `grant run --inject` as one line, `CULTURE_AGENTS_FLEET_KEY=ed25519:<base64 PKCS#8>`. Read once at start and deleted from the environment, like every other injected secret. | t21 |
| 3. Announcement | Each core announces itself every 5 seconds to the peers in a local, untracked address list, over the fleet transport. A peer is listed only after an announcement arrives from a trusted key, and only under the node name the trust list gives that key. It is dropped after 15 seconds of silence, or at once when it says it is leaving. | t22, t25 |
| 4. Same repository | The operator gives the checkout the same alias on each host, and the alias resolves to an allow-listed path on that host. The core never infers that two checkouts are the same; it checks the commit. | t23 |
| 5. Base commit | The caller may name a commit, and the executing core refuses the submit if that commit is not in its checkout. When no commit is named, the run starts from the executing host's HEAD at acceptance, which is recorded and returned. | t23 |

## How the probes ran

All four probes are under `spikes/d2-part-two/` (see its `README.md`). They
use Node's standard library only and add no npm dependency. They ran on one
`x86_64` machine with no network, using Node v22.23.5 (OpenSSL 3.5.9) and git
2.43.0. Two processes on loopback stand for two cores, so they measure the
protocol and the code paths, not a network. Each probe deletes its keys and
temporary files when it finishes. The evidence files hold booleans, lengths,
timings and shortened commit ids, never a key.

What loopback cannot show, and what is therefore **NOT VERIFIED** until task
t28 runs on two real hosts:

- latency and jitter between hosts, and how the 15 second silence threshold
  holds up under them;
- packet loss, and how often a live member is dropped by mistake;
- clock difference between real hosts. A 1 hour offset in the announced time
  was simulated, but no real clock drift was measured;
- NAT and firewalls: whether a core behind NAT can be called back, and which
  port the operator must open;
- a second Node or OpenSSL build, for example on an ARM host such as the
  Jetson Thor of the examples, and whether it accepts Ed25519 in TLS 1.3;
- grant itself: it is not installed here, so storing and injecting the key
  through grant was not run;
- the OpenShell sandbox: whether a process inside it can read the host's
  `/proc`. OpenShell is not available here.

## Decision 1: the transport between cores

Two cores need an encrypted connection on which each proves it holds the
private key of a member the other trusts, using Node's standard library only.

**Options.**

- **T1. TLS 1.3 with mutual authentication, using certificates derived from
  the key pairs.** Each core makes a self-signed X.509 certificate from its
  Ed25519 key at start. Node can parse certificates but cannot create them, so
  the core encodes about 60 lines of DER itself. Each core's trust list holds
  member certificates, which are public. OpenSSL verifies the peer against
  that list during the handshake, in both directions.
- **T2. TLS with a pre-shared key.** This is a shared secret, which c37 rules
  out.
- **T3. Our own handshake over `node:net`,** built from `node:crypto`
  primitives (X25519, Ed25519 signatures, AES-GCM). It needs no certificate,
  but it is a cryptographic protocol of our own, with no review behind it.
- **T4. SSH tunnels (OpenSSH).** This is outside Node, needs an account and a
  shell on each host, and t26 requires no shell access.
- **T5. Rely on a VPN or tailnet underneath, with no authentication in the
  core.** Membership would then be whoever the network admits, not who holds
  a member key, and nothing in the core could revoke one member.

**Recommendation: T1.** In detail:

- **Key type.** Ed25519. Its signatures are deterministic, and every field of
  the certificate is fixed or derived from the public key: the subject is the
  key's fingerprint and the validity runs from 2000 to 9999. So one key always
  gives the same certificate bytes, and nothing but the private key is stored.
  Trust ends when the certificate is removed from the trust list, not on a
  date.
- **Trust list.** A local JSON file of `{ node, cert }` entries in the user's
  XDG config directory, beside the existing allow-list (planned path
  `culture-agents/fleet/trust.json`). It is untracked, like the allow-list.
  The operator adds a member by adding its one-line certificate, which a
  t21 command prints together with the SHA-256 fingerprint to compare by eye.
  A trust list that gives one node name to two keys is refused at start.
- **Server.** `requestCert: true`. The handshake completes only with a
  certificate from the trust list. After it, the core looks up the trust-list
  entry for the peer's public key and passes the socket to the HTTP server
  with `emit('connection')`. The core reads no request from a peer that fails
  this check. When the trust file changes, `setSecureContext` installs the
  new trust list for the next connection.
- **Client.** It verifies the server against its own trust list. The host
  name check is replaced by the trust-list check, because a member is its key,
  not a name. It writes nothing until that check has passed.
- **TLS settings.** TLS 1.3 only. The server sets `SSL_OP_NO_TICKET`: Node's
  default server hands out a session ticket that lets a peer resume without
  presenting its certificate again, and such a ticket is a reusable secret.
- **Connections.** One connection per call, with no keep-alive in D2.
  Revocation then takes effect on the next call, and nothing outlives a trust
  change.
- **Listening.** The transport is off unless a listen address is configured.
  Nothing reads the chat mesh's link password.

One TLS 1.3 detail matters for t21's error messages. The client finishes its
side of the handshake before the server has checked the client certificate,
so a refused client only sees the connection close, as `ECONNRESET` on its
first read. The refusing core does see the reason: OpenSSL's code
`DEPTH_ZERO_SELF_SIGNED_CERT` means the certificate is not in the trust list.
The core logs that for the operator. In the alternative strict mode, where
OpenSSL aborts the handshake itself, Node reports only "socket hang up", so
the probe uses the default mode and destroys the socket instead.

**Probe.** `node spikes/d2-part-two/transport-probe.mjs`. Evidence:
`spikes/d2-part-two/evidence/transport.ndjson`. Core A runs as one process
and core B as another, on 127.0.0.1.

| Case | Result on loopback |
| --- | --- |
| A and B trust each other | B reads `/v1/version` from A (status 200). Each side identifies the other by its trust-list entry. |
| Bytes captured by a proxy between B and A (4416 bytes) | None of 12 searched patterns was present: each private key as PKCS#8 DER, as the 32-byte seed, in the one-line form and as PEM; each certificate (TLS 1.3 encrypts it); the plaintext request line; a response field name. |
| B presents a key A does not trust | A refuses it with the reason logged. A served the same number of requests before and after (1 and 1). |
| A presents a key B does not expect | B refuses before writing (`DEPTH_ZERO_SELF_SIGNED_CERT`). |
| B's certificate removed from A's trust list, then A reloaded | B's next connection is refused. |
| Session resumption | Node's default server resumed a session (true). The fleet server with `SSL_OP_NO_TICKET` did not (false). |
| Cost of a full handshake, 50 connections | Median 2.87 ms, 90th percentile 4.46 ms (loopback). |

**Cost.**

- About 60 lines of hand-written DER for the certificate. If the encoding were
  wrong, the handshake would fail, not pass quietly. Node's `X509Certificate`
  parses the result, and the certificate verifies against its own key.
- About 150 lines of TLS glue in `core/src/fleet/transport.ts`.
- One TLS handshake per call.
- On each host, an entry per member that the operator maintains by hand. The
  spec already decided this.

**What would change it.**

- A host whose Node or OpenSSL refuses Ed25519 in TLS 1.3: the code stays the
  same and the key type becomes ECDSA P-256.
- The owner preferring an `openssl req` step run by the operator to a
  hand-written encoder: the certificate would then be a stored file beside the
  key.
- t28 showing that the handshake per call costs too much on a real link:
  keep-alive connections, with the trust list checked again on each request.

## Decision 2: where a core's private key lives and how it reaches the core

**Options.**

- **K1. grant injects it into the environment.** The core reads it once at
  start and deletes it, through the existing `takeSecrets`, with
  `CULTURE_AGENTS_FLEET_KEY` added to `INJECTED_SECRETS` in
  `core/src/daemon/secrets.ts`. This is the path the spec names (h27), and the
  one every other secret of the core already takes.
- **K2. A key file,** mode 0600 in a 0700 directory under the user's XDG
  config directory, read once at start. The core refuses a file that other
  users can read.
- **K3. grant plus a launcher.** The launcher reads the variable and starts
  the core with the key on file descriptor 3 and a clean environment.
- **K4. A systemd credential** (`LoadCredential`, optionally encrypted with
  `systemd-creds`). This depends on how the core is supervised, which the plan
  leaves undecided.
- **K5. The OS keyring.** It needs a native module, which is a new
  dependency.

**Recommendation: K1, with the key in a one-line form.** The form is
`ed25519:` followed by the base64 of the PKCS#8 DER, 72 characters with no
newline. It fits grant's string values, so whether grant keeps a multi-line
PEM intact never comes up, although the probe shows that a PEM also survives
an environment variable. The certificate is derived from the key in memory.
The key is never written to a log, an event, a run record or a tracked file.
If it is missing or invalid, the transport does not start, and the core says
why without printing the value. Rotation stays as decided: add the new
certificate on each peer, restart with the new key, remove the old
certificate.

**Probe.** `node spikes/d2-part-two/key-probe.mjs`. Evidence:
`spikes/d2-part-two/evidence/key.ndjson`. A stand-in core takes the key, signs
a challenge with it, and spawns a worker with its own `process.env`.

| Case | Key usable | In the worker's environment | Still in the core's `/proc/<pid>/environ` |
| --- | --- | --- | --- |
| K1, one-line form in the environment | yes | no | **yes** |
| K1, multi-line PEM in the environment | yes | no | **yes** |
| K3, file descriptor 3 from a launcher | yes | no | no |
| K2, file at 0600 | yes | no | no |
| K2, file at 0644 | refused at start | n/a | n/a |

The worker could read `/proc/<core pid>/environ`, because it runs as the same
user. Deleting a variable from `process.env` does not erase the environment
block the process started with. grant is not installed here, so injection
through grant itself is **NOT VERIFIED**.

**Cost.** Under K1, any process of the same user, including the core's own
workers and host commands, can read the key from `/proc/<core pid>/environ`
for as long as the core runs. Other users cannot. This does not widen who can
read the key: grant keeps it in a plaintext file at mode 0600 (spec entry
s30), which any process of that user can already read. The harness runs
inside the OpenShell sandbox, not as a host process. Whether the sandbox can
see the host's `/proc` was not checked here (see above).

**What would change it.**

- The owner deciding that the `/proc` residue matters: K2 is the smallest
  change, because the core reads a file once and the same code handles the
  rest.
- Supervision becoming a systemd unit: K4 then gives the same file-shaped
  read, with encryption at rest.

## Decision 3: how a core announces itself and is dropped

The member list must be built from announcements only. It must not travel over
the chat mesh, and membership must not be pointed at publicly.

**Options.**

- **A1. The chat mesh.** The owner excluded it.
- **A2. The events-cli broker.** It listens on loopback only and accepts
  anonymous clients. Carrying membership between hosts would need remote
  access, TLS and access rules, which events-cli issue 10 lists as not built.
- **A3. Multicast or broadcast discovery on the local network.** It announces
  membership to every machine on the segment, which is exactly the public
  pointing the owner ruled out. It does not cross routed networks or
  tailnets, and it is unauthenticated unless more work is added.
- **A4. A registry served by one core.** That core becomes a single point of
  failure, and someone must choose it.
- **A5. Direct announcements over the fleet transport.** Each core sends them
  to the peers in a local, untracked list of addresses.

**Recommendation: A5.** In detail:

- **Address list.** Each core with the transport on has a local list of
  addresses to announce to, stored in the user's XDG config directory beside
  the trust list. It is configuration, not membership: an address with no
  live core behind it is never listed. This is the only place an address is
  written, and it is never tracked.
- **Announcement.** `POST /v1/fleet/announce` with `node`, `api_version`,
  `seq` and `state` (`up` or `leaving`), sent every 5 seconds over the fleet
  transport. The reply is the peer's own announcement, so when only one of two
  cores knows the other's address, both still list each other.
- **Listing.** A peer is listed only after an announcement from an
  authenticated key, and only under the node name its trust-list entry gives.
  An announcement claiming another name is refused with `conflict` and
  reported to the operator. Two members can therefore never share a node name
  (c40).
- **Dropping.** A peer is dropped when nothing has been heard from it for 15
  seconds, checked every second, or at once when it announces `leaving` on a
  clean stop.
- **Clocks.** Silence is measured on the receiving core's monotonic clock. The
  sender's timestamps are never read, and no timestamp from one host is ever
  compared with a clock on another (c42).
- **Timeouts.** Every request has a timeout of one interval, 5 seconds, so a
  frozen peer cannot hold a call open.
- **Who can read the list.** Only the local socket owner and authenticated
  members. It is published nowhere else.

Detection, stated: a clean stop is detected within 1 second. A crashed,
halted or partitioned core is dropped within 16 seconds of the last
announcement heard from it: 15 seconds of silence plus a 1 second sweep. A
returning core is listed again at its next announcement, which comes every 5
seconds. See [Detection times](#detection-times).

**Probe.** `node spikes/d2-part-two/announce-probe.mjs`, run at the stated
numbers (interval 5 seconds, silence 15 seconds). Evidence:
`spikes/d2-part-two/evidence/announce.ndjson`. Core A knows no address. Core B
(`thor`) is configured with A's port. A frozen process (`SIGSTOP`) stands in
for a halted host or a partition, because its TCP socket stays open and it
sends nothing, which is how a halted host looks from A.

| Case | Result on loopback |
| --- | --- |
| A before any announcement | lists nobody |
| B starts | B is on A's list after 0.125 s, and A on B's after 0.134 s, through the reply |
| B stops cleanly (`SIGTERM`, sends `leaving`) | dropped after 0.005 s |
| B crashes (`SIGKILL`) | dropped as silent after 15.537 s |
| B freezes (`SIGSTOP`), with its clock set 1 hour ahead | dropped as silent after 15.918 s; the false clock changed nothing |
| B resumes (`SIGCONT`) | listed again after 0.006 s (its overdue announcement went out at once) |
| A freezes, as seen by B | B drops A after 15.002 s; B's announcements fail with `ETIMEDOUT` at 5 s |
| A third core, trusted as `host-c`, claims `thor` | refused with 409 and reported on A; `thor` stays with B's key |
| A core with an untrusted key announces | refused in the handshake and never listed |
| A trust list naming `thor` twice | the core refuses to start (exit 2) |

**Cost.**

- Every core announces to every configured peer. With n hosts that is
  n × (n − 1) small requests every 5 seconds, each with its own TLS handshake
  (a median of 2.87 ms on loopback). Ten hosts make 90 requests every 5
  seconds.
- A halted host stays listed for up to 16 seconds.
- A core can be found only through an address someone configured, which is
  the point.

**What would change it.**

- t28 showing live members dropped on real links: raise the silence
  threshold.
- The owner wanting faster detection: for example a 2 second interval and a 6
  second silence, at 2.5 times the traffic and with more false drops on a
  lossy link.
- A fleet of more than about 20 hosts: relayed announcements or persistent
  connections.

## Detection times

The number of seconds for each detection. t22 and t25 test against these, and
t28 measures them on two real hosts.

| Detection | Stated bound | Measured on loopback |
| --- | --- | --- |
| A core that stops cleanly leaves the member list | within 1 s | 0.005 s |
| A core whose process dies leaves the list | within 16 s | 15.537 s |
| A halted or partitioned host leaves the list | within 16 s | 15.918 s |
| The announcing core sees the peer it announces to go silent | within 16 s | 15.002 s |
| One call to an unreachable member fails | within 5 s | 5 s (`ETIMEDOUT`) |
| A returning core is listed again | within 5 s (one interval) | 0.006 s |
| A run on a member reads `unreachable` to a caller (t25) | within 16 s of the member's last announcement, or within 5 s of a failed call | not probed separately; follows from the rows above |

The `unreachable` view is computed by the caller and never stored (c47). Only
the owning core writes `unknown`, with evidence that the worker is gone.

## Decision 4: what makes two checkouts the same repository

The owner said one repository can exist on more than one host. Today
`repo_path` is an absolute path on the core's own host, and nothing relates
two checkouts.

**Options.**

- **R1. An alias each host defines.** For example `culture-agents` resolves
  to an allow-listed path on that host. The operator asserts that two hosts'
  aliases are the same repository.
- **R2. The root commit or commits of HEAD.** This is intrinsic to the
  history.
- **R3. The normalised `origin` URL.**
- **R4. An identity file committed in each repository.**
- **R5. The absolute path on the executing host.** This is the 3.0 `repo`
  field as it is.

**Probe.** `node spikes/d2-part-two/repo-probe.mjs`. Evidence:
`spikes/d2-part-two/evidence/repo.ndjson`.

- Two clones of one upstream have the same root commit.
- An unrelated repository has a different one.
- A fork with new commits shares the root, so R2 cannot tell a fork from the
  original.
- A shallow clone (`--depth 1`) reports a different root, so R2 breaks on
  shallow clones.
- The same upstream spelled two ways (a path and a `file://` URL) gives two
  unequal origin strings, and a repository made locally has no origin at all,
  so R3 is fragile and sometimes undefined.

**Recommendation: R1, with the commit as the only thing the core checks.**

- **Naming.** For D2, "the same repository" is a claim the operator makes by
  giving the checkout the same alias on each host. The core never infers it.
- **Checking.** What matters for a run is the code it starts from, and a
  commit id is content-addressed. If the executing checkout contains the
  named commit, the run starts from exactly that tree, whatever else differs
  between the checkouts (Decision 5).
- **Paths.** The alias resolves to a path on the executing host, and the
  existing allow-list (keyed on agent, harness and canonical repository)
  applies unchanged. Paths stay private to each host: another member sees
  aliases, never paths.

Contract consequence for t23: in 3.0, `repo` is a required absolute path, and
a MINOR addition may not change an existing shape. So the member-to-member
submit is a new route with its own request shape (alias and optional base
commit), and the list of aliases a member may use is a new route. Both are
3.x MINOR additions.

**Cost.**

- One more local configuration entry per repository per host.
- Nothing checks that two hosts' aliases name the same project. A mis-set
  alias is caught when a named commit is missing, but not when no commit is
  named.

**What would change it.**

- The owner wanting a mis-set alias caught without a named commit: add R2 as
  a warning, not a refusal, given its fork and shallow-clone blind spots.
- AgentCulture adopting a committed repository id (R4) across repositories.

## Decision 5: which commit a remote run starts from

Part one records the base commit when a submit is accepted: it is the
executing host's HEAD at that moment (t7). With two hosts, the caller's HEAD
and the executing host's HEAD can differ.

**Options.**

- **B1. The executing host's HEAD at acceptance,** as on one host.
- **B2. The caller names a commit,** and the executing core refuses the submit
  when that commit is not in its checkout.
- **B3. The caller sends the missing commits as a git bundle** with the
  submit, and the executing core verifies the bundle and stores it under a
  run-scoped ref.
- **B4. The executing core fetches from a shared remote.** This needs network
  credentials on the executing host and lies outside the control plane.

**Probe.** `node spikes/d2-part-two/repo-probe.mjs` (the same probe as
Decision 4). Evidence: `spikes/d2-part-two/evidence/repo.ndjson`.

- **The checkouts differ.** Host A has an unpushed commit that host B lacks.
  Starting from B's HEAD (B1) would run on code the caller does not have in
  front of it.
- **Checking a named commit (B2)** is one `git cat-file -e <sha>^{commit}`,
  2.6 ms here, with a plain error when the commit is missing.
- **A bundle of a bare commit id** is refused ("Refusing to create empty
  bundle"). The core must point a run-scoped ref (for example
  `refs/culture-agents/base/<run id>`) at the named commit before bundling it
  into the sandbox. That works.
- **B3:** a thin bundle of only the missing commits was 374 bytes against
  6,536 bytes for the whole synthetic history. It verified on B and fetched
  into a run-scoped ref, but it fails to verify where the common base is
  absent. A full bundle of this repository's HEAD (144 commits) is 1,699,443
  bytes.

**Recommendation: B2, with B1 when no commit is named.**

- **Request.** The member-to-member submit carries an optional `base_commit`,
  a full 40-character commit id.
- **Named commit.** If it is present, the executing core checks it in the
  aliased checkout when it accepts the submit. If the commit is missing, the
  submit is refused with the existing `invalid` code and a message naming the
  commit. Nothing is fetched behind the operator's back.
- **No commit named.** The run starts from the executing host's HEAD at
  acceptance, as in t7. The commit is recorded and returned in the submit
  response, so the caller always sees which code the run started from.
- **Sandbox.** The sandbox bundle is built from a run-scoped ref that points
  at the recorded commit.

**Cost.**

- The operator must make sure a named commit reaches the executing host
  (push, or fetch there) before submitting.
- Under B1, a caller that names no commit gets whatever the executing host has
  checked out. It is told which commit that was, but it is not stopped.

**What would change it.** Operators finding the out-of-band sync painful. B3
then becomes a new upload route, the reverse of t26's result bundle. The probe
shows it works and is small when a common base is known.

## What each part two task takes from this record

| Task | Decided here |
| --- | --- |
| t21 transport | Decision 1 in full, the key of Decision 2, the trust-list file and its duplicate-name refusal, no session tickets, one connection per call, the transport off by default |
| t22 members | Decision 3: the announce route, the 5 second interval and 15 second silence, the address list, names bound to keys by the trust list, the `conflict` refusal reported to the operator |
| t23 remote calls | Decisions 4 and 5: an alias plus an optional `base_commit` in a new member-to-member submit route, a new route listing aliases, and `invalid` for a missing commit. The announcement carries `api_version` for t23's version rule |
| t24 admission | Nothing new. The executing core decides, and an unknown signal refuses a remote submit (already decided in the spec) |
| t25 unreachable | The seconds in [Detection times](#detection-times): 16 seconds from the last announcement, 5 seconds for a failed call |
| t26 bundles and reads | Who may read a cross-host run (open question 8). A sensitivity mark cannot be a new field on a 3.0 shape, because that is MAJOR. It is cheap only as an HTTP response header or inside a new 3.x route, and t26 records which it chose |
| t28 acceptance | Every item marked NOT VERIFIED in [How the probes ran](#how-the-probes-ran) |

## Owner approval

Status: approved 2026-11-27

The owner approved this record on 2026-11-27 with the words "part two
approved", without changes. No question was answered separately, so each of
the nine open questions below stands at its recommended answer, which is the
one each question states. In particular: the fleet key is injected through
the environment and stays readable to processes of the same user (question
3), and a remote run's logs may be read only by the local operator and the
member that submitted it (question 8). An answer the owner changes later is
recorded here with its date.

No part two code task (t21, t22, t23, t24, t25, t26) starts until this line
reads `Status: approved` with a date, and with any changes the owner asked for
written into the decisions above. The answers to the open questions below are
recorded here when they are given.

## Open questions for the owner

Each question can be answered in a line. The recommended answer is given
first.

1. Approve TLS 1.3 between cores, authenticated both ways with a certificate derived in memory from each core's Ed25519 key and checked against a per-host trust list (Decision 1)?
2. Is a hand-written encoder of about 60 lines for that self-signed certificate acceptable, instead of operators running `openssl` and storing a certificate file?
3. Accept that a grant-injected key stays readable in `/proc/<core pid>/environ` to processes of the same user (as grant's own store already is), or should the key come from a 0600 file instead (Decision 2)?
4. Are a 5 second announcement interval and a 15 second silence threshold (dropped within 16 seconds) right for your links, or do you want faster detection at more traffic?
5. May each host keep a local, untracked list of peer addresses to announce to, as the only place an address is written?
6. Should a repository be named across hosts by an alias each host defines, rather than by its absolute path on the executing host (Decision 4)?
7. Should a remote run start from a commit the caller names, refused when the executing host lacks it, and from the executing host's HEAD when none is named (Decision 5)?
8. Who may read a remote run's logs and attach to it: only the local operator and the member that submitted it (recommended), or every member?
9. Should `agents runs submit` to another member send the caller's HEAD as the base commit by default when run inside a checkout of that repository, or only when `--base` is given?
