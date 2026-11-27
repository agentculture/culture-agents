# TASK-REPORT t21: network transport beside the Unix socket

## What I built

Decision 1 (transport) and Decision 2 (private key) of
`docs/d2/part-two-design.md`, as that record recommends, in `core/src/fleet/`:

- `cert.ts`: the Ed25519 key in its one-line form
  (`ed25519:<base64 PKCS#8>`, 72 characters), parsing that never echoes the
  value, and the self-signed X.509 certificate derived in memory from the key.
  The certificate is deterministic, valid from 2000 to 9999, with the
  fingerprint as subject. It also has a parser that refuses any certificate
  that is not Ed25519 and self-signed.
- `trust.ts`: the trust list at
  `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/trust.json`, made of
  `[{ node, cert }]` entries. It is refused when it gives one node name to two
  keys or one key to two names, has unknown fields or bad entries, or is over
  1 MiB. A missing file trusts nobody. A per-connection source re-reads the
  file, and when the file turns invalid at runtime it refuses everyone and
  logs why.
- `transport.ts`:
  - The server is TLS 1.3 only, with `requestCert` and `SSL_OP_NO_TICKET`.
    The trust file is re-read on each TCP `connection` event, before the
    handshake, and a changed list is installed with `setSecureContext`.
  - After the handshake, the peer's public key must match a trust entry, or
    the socket is destroyed before the HTTP server sees it. The reason and a
    16-character fingerprint prefix are logged.
  - Limits: 5 s handshake timeout, 5 s request timeout, 16 KiB headers, 64
    connections, one request per connection.
  - The client verifies the server against its own trust list before writing
    (optionally against an expected node name). It has one 5 s timeout per
    call and a 1 MiB response cap.
- `config.ts`: the transport is off unless `CULTURE_AGENTS_FLEET_LISTEN` is
  `<ip>:<port>` or `[<ipv6>]:<port>`. A host name is refused. When it is set,
  the held key and a valid trust list are required.
- `index.ts`: wiring. While the transport is on, a member is served only
  `GET /v1/version`, and every other path answers `not_found`. No local
  control route is reachable over the network. No route was added to the
  contract.
- `command.ts`: a new bin, `culture-agents-fleet`, added to `package.json` and
  `package-lock.json`. No new dependency.
  - `keygen` prints a new key line.
  - `cert [--node]` reads `CULTURE_AGENTS_FLEET_KEY` and prints the trust
    entry and its `sha256:` fingerprint. The design record names this as a t21
    command.
- `core/src/daemon/secrets.ts`: `CULTURE_AGENTS_FLEET_KEY` is added to
  `INJECTED_SECRETS`. It is therefore taken out of the environment at the same
  point as the other secrets, before any socket listens, and dropped by name
  from workers, host commands and the sandbox environment.
- `core/src/daemon/main.ts`: `prepareFleet` runs right after `takeSecrets`
  and `prepareTrace`. A bad configuration exits 2 before the Unix socket
  listens. The fleet listener starts after the daemon. If it cannot bind, the
  daemon is stopped and the exit code is 2. It is stopped first on shutdown.
- Docs:
  - `docs/d2/fleet-transport.md`, which includes the `/proc/<pid>/environ`
    residue and what is NOT VERIFIED;
  - `core/README.md` (injected secrets list, plus a fleet section);
  - one paragraph in each of CLAUDE.md, AGENTS.md, AGENTS.colleague.md,
    AGENTS.override.md and QWEN.md, saying that the transport exists and is
    off by default.

### Defect found while testing (fixed)

When a `tlsClientError` listener is installed, Node does **not** destroy the
socket on a handshake timeout. The listener now destroys the socket. The test
"a handshake that never starts is cut off by the handshake timeout" hung until
this was fixed.

## Tests run (final state, last commit before this report)

- `cd core && npm run build && npm test`: 748 tests, **736 passed, 0 failed,
  12 skipped**. 32 of them are new, in `core/test/fleet/`.
  - An earlier full run had 1 failure in
    `test/runs/idempotency.test.ts` ("the daemon prunes keys on its
    housekeeping interval"): `ENOTEMPTY` in the test's own `rmSync` cleanup.
  - That test does not touch fleet code. It then passed 3 times standalone and
    in the next 2 full runs.
- `npm run typecheck`, `npm run lint` and `npm run check:contract-types`: all
  clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (after the core
  build): **1793 passed, 1 failed, 13 skipped**.
  - The one failure is
    `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`.
    `uv build` cannot reach pypi.org to fetch hatchling ("tcp connect error,
    Permission denied"), because this sandbox has no package registry.
  - I touched no Python file, and I did not run that test on the base commit.
- `python3 scripts/check-example-node.py`, `scan-secrets.py` and
  `check-file-length.py`: all clean. The largest new file is
  `core/src/fleet/transport.ts`, at 240 lines.
- **Not run:**
  - markdownlint-cli2, which is not installed here;
  - the Python lint tools (black, isort, flake8, bandit), because no Python
    file changed;
  - `teken cli doctor`;
  - `harness-smoke.py`.

## Acceptance criteria

1. **Proven.** Two cores connect over an encrypted channel authenticated in
   both directions by key, an unknown or removed key is refused before any
   request is read, and no private key or reusable secret crosses the network.
   Tests in `core/test/fleet/transport.test.ts`:
   - "two cores authenticate each other by key…": each side identifies the
     other by its fingerprint.
   - "the captured bytes hold no private key, no certificate and no plaintext
     request": a recording proxy captures the bytes between the cores, and
     each key is searched for as PKCS#8 DER, the 32-byte seed, the key text
     and PEM. Each certificate and the plaintext request and response are
     searched for too. None is found.
   - "no session can be resumed on the fleet server, while a default TLS
     server resumes one". Resumption, not tickets, is what is asserted: in
     TLS 1.3 OpenSSL still sends a stateful session id with `NO_TICKET`, but
     Node keeps no server session cache, so the id cannot be used.
   - "a core with an unknown key is refused before any request is read" and
     "a peer with no certificate…": the application request count stays 0.
   - "the caller refuses a server whose key it does not trust…".
   - Removed keys: `trust.test.ts` "adding a key admits … removing it refuses
     the next connection".
   - The real `main`: `config.test.ts` "a core with the transport on serves a
     member…".
2. **Proven.** Adding a member is adding its public key, and removing the key
   revokes it on the next connection. One member's key gives no access to
   another's private key. Tests in `trust.test.ts`:
   - "adding a key admits the member and removing it refuses the next
     connection, with no restart".
   - "a trust list holds certificates only".
   - "holding a member's certificate without its private key does not let a
     core present it": OpenSSL reports "key values mismatch", and the
     connection is refused.
   - "a private key pasted where a certificate belongs is refused without
     echoing it".
   - Duplicate node name refused.
3. **Proven** for what can be shown here. The transport is off unless
   configured, nothing reads the chat mesh's link password, and the suite
   passes with no chat server running. Tests in `config.test.ts`:
   - "the transport is off unless a listen address is configured, even with a
     key held": a recording environment shows that only
     `CULTURE_AGENTS_FLEET_LISTEN` is read, and a decoy mesh-password variable
     is never read.
   - "a configured transport reads … and nothing else": only the listen
     variable and `XDG_CONFIG_HOME` are read.
   - "no core source names the chat mesh's configuration or link password", a
     scan of the built `dist/src`.
   - "a core started without a listen address opens no fleet transport", with
     the real `main` in a child process.
   - No chat server: the listening TCP sockets in `/proc/net/tcp*` during the
     runs were the harness bridge (`bridge.mjs`) and the local DNS stub. No
     `culture` or `agentirc` is installed. Both suites passed (apart from the
     packaging failure above).

Key handling, also tested (`config.test.ts`): after start the key is absent
from the core's `process.env`, from `hostEnv()` and from a spawned worker's
`/proc/<pid>/environ`. A bad key or trust list exits 2 before the Unix socket
listens, and the key is never in the output. The existing
`test/daemon/secrets.test.ts` covers the new name automatically, because it
iterates `INJECTED_SECRETS`.

## Choices and assumptions

- **Configuration by environment variable.** The design record says "a listen
  address is configured" without naming the means. I chose
  `CULTURE_AGENTS_FLEET_LISTEN`, which is consistent with the trace and broker
  settings, and I refuse host names.
- **Misconfiguration stops the core (exit 2).** If the transport is configured
  but the key is missing or invalid, or the trust list is invalid, the core
  stops rather than running without the transport. This matches the probe's
  exit 2 for a duplicate name and the trace-endpoint rule.
- **The served route.** Only `GET /v1/version` is served over the network, so
  that t21 does not expose local control routes before t22 and t23 decide
  member authorization.
- **The key stays in `/proc`.** The key remains readable in
  `/proc/<core pid>/environ` to the same user, as the owner accepted
  (question 3). This is stated in `secrets.ts`, `cert.ts`, `core/README.md`
  and `docs/d2/fleet-transport.md`.
- **Duplicate-key test.** The duplicate-key refusal (one key under two names)
  is implemented but not tested by name, because a second node name is not
  allowed in tests. The duplicate-name refusal is tested.
- **Not measured here:** a real network, another Node or OpenSSL build, and
  injection through grant, which is not installed. These are left for t28.

## Left unchanged on purpose

- The Unix socket path, `daemon.ts`, routes and their tests.
- `contract/`, which has no route or shape change.
- `spikes/`, which nothing imports.
- `.claude/skills` and `.devague`.
- Python code.
- `CHANGELOG.md` and the version. `tests/test_version_bump.py` ties them to
  releases, so the bump is left to the merge.
- `docs/d2/part-two-design.md`.
