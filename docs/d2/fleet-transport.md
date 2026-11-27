# The fleet transport (D2 part two, task t21)

Status: built in `core/src/fleet/`, **off by default**. This is the network
transport between cores that `docs/d2/part-two-design.md` chose (Decision 1)
with the key handling it chose (Decision 2). It is the first piece of part
two. The member list runs on it (task t22, `docs/d2/fleet-members.md`). Remote
calls and everything else in part two are not built (tasks t23 to t26). The
Unix socket and its behaviour are unchanged.

## What it does

- **Off unless configured.** The core opens no network listener unless
  `CULTURE_AGENTS_FLEET_LISTEN` is set to `<ip>:<port>` or
  `[<ipv6>]:<port>`. A host name is refused, so the operator names the
  interface exactly. Nothing reads the chat mesh's configuration or its link
  password.
- **Authenticated in both directions by key.** TLS 1.3 only, from
  `node:tls`. Each core presents a self-signed certificate derived in memory
  from its Ed25519 key, and trusts exactly the certificates in its own trust
  list. A member is its key, not a name.
- **Refused before any request is read.** After the handshake, the server
  looks up the peer's public key in the trust list. A peer with no
  certificate, an unknown certificate or a removed one is disconnected, and
  no byte of its request is parsed. The core logs the reason and the first
  16 hex characters of the peer's fingerprint. In TLS 1.3 the client
  finishes its side of the handshake first, so a refused client sees the
  connection close, not an error message.
- **The client checks the server first.** A calling core verifies the
  server's certificate against its own trust list and writes no request
  until that check has passed.
- **No reusable secret on the wire.** No private key leaves the core. The
  server sets `SSL_OP_NO_TICKET` and keeps no session cache, so no session
  can be resumed. In TLS 1.3 OpenSSL still sends a stateful session id, but
  nothing on the server accepts it. A test captures the bytes between two
  cores and searches them for each private key in four encodings, each
  certificate, and the plaintext request and response.
- **Bounded.** Every handshake times out after 5 seconds, and so does every
  request on the server side. Every call made by the client times out after
  5 seconds, and the client reads at most 1 MiB of a response. Request
  headers are capped at 16 KiB, and the server accepts at most 64 connections
  at once. There is one connection per call, with no keep-alive.
- **Routes.** The transport serves an authenticated member
  `GET /v1/version`, `POST /v1/fleet/announce` and `GET /v1/fleet/members`
  (t22, `docs/d2/fleet-members.md`). Every other path answers `not_found`. No
  local control route can be reached over the network. Remote calls come in
  t23.

## The trust list

`${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/trust.json` is a
local, untracked file beside the allow-list:

```json
[{ "node": "thor", "cert": "<one base64 line>" }]
```

- **Adding a member** means adding its entry. **Removing the entry revokes
  it** on its next connection. The server reads the file again as each
  connection arrives, before the handshake, so no restart is needed.
- The file holds certificates, which are public. Nothing in it, and nothing a
  member receives, gives access to another member's private key. A
  certificate without its private key cannot be presented: OpenSSL refuses
  the pair.
- A list that gives one node name to two keys, or one key to two names, is
  refused. The core does not start with it. If the file is changed to
  something invalid while the core runs, every peer is refused, and the core
  logs why until the file is fixed. The file may be at most 1 MiB.
- The operator prints an entry with `culture-agents-fleet cert [--node
  <name>]`, run under `grant run --inject`. The command prints the entry and
  the SHA-256 fingerprint to compare by eye.

## The key

- `culture-agents-fleet keygen` prints a new key as one line,
  `ed25519:<base64 PKCS#8>`, for the operator to store in grant. That is the
  only output of this repository that holds a private key.
- grant injects it as `CULTURE_AGENTS_FLEET_KEY`. The core reads it once at
  start and deletes it from its environment, together with the other injected
  secrets, before any socket listens (`INJECTED_SECRETS` in
  `core/src/daemon/secrets.ts`). Workers, host commands and the sandbox
  environment filter drop it by name. The core reads the key only when the
  transport is configured.
- **What this does not do:** the kernel keeps the environment the core
  started with. The key therefore stays readable in
  `/proc/<core pid>/environ` to every process of the same user, the core's
  own workers and host commands included, for as long as the core runs.
  Other users cannot read it. The owner accepted this on 2026-11-27 (design
  record, question 3). grant itself keeps the key in a 0600 file that the
  same user can already read.
- If the transport is configured and the key is missing or invalid, or the
  trust list is invalid, the core stops with exit 2 before its Unix socket
  listens. The message never contains the key. If the listen address cannot
  be bound, the core stops its Unix socket again and exits 2.

## What was measured, and what was not

- **Measured on loopback, in `core/test/fleet/`:** both directions of
  authentication, the byte capture, the refusals, revocation and admission
  without a restart, no resumption, the handshake timeout, the response cap,
  the call timeout, and the real `main` with the transport on, off and
  misconfigured. Both cores ran on one machine.
- **NOT VERIFIED until t28 runs on two real hosts:** a real network (latency,
  loss, NAT, firewalls), another Node or OpenSSL build (for example on ARM),
  and injection through grant itself, which is not installed here.
