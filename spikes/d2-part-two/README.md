# D2 part two probes (task t20)

Throwaway probe code behind `docs/d2/part-two-design.md`. Never built, linted or
held to the line cap. Node's standard library only (Node 22, `node:crypto`,
`node:tls`, `node:net`, `node:http`); no npm dependency. Every probe runs on one
machine: two processes on loopback stand for two cores.

| Probe | Command (from the repository root) | Evidence | Runs |
| --- | --- | --- | --- |
| Transport | `node spikes/d2-part-two/transport-probe.mjs` | `evidence/transport.ndjson` | about 2 s |
| Key handling | `node spikes/d2-part-two/key-probe.mjs` | `evidence/key.ndjson` | under 1 s |
| Announcement | `node spikes/d2-part-two/announce-probe.mjs` | `evidence/announce.ndjson` | about 55 s |
| Repository identity | `node spikes/d2-part-two/repo-probe.mjs` | `evidence/repo.ndjson` | about 1 s |

`announce-probe.mjs --interval-s 1 --silence-s 3` runs the same cases in about
15 s; the committed evidence is from the stated numbers (5 and 15).

Files: `lib.mjs` (keys, a certificate derived from the key, TLS with a trust
list, evidence writer), `core.mjs` (a stand-in core: listener, announcer,
member list), `proc.mjs` (starting stand-in cores as child processes).

Keys are generated per run in a temporary directory that is removed at the
end. No key, no host name and no address other than 127.0.0.1 is written to
`evidence/`. Node names in the probes are role labels: `host-a`, `thor`.
