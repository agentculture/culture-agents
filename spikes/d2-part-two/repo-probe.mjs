// Probe 4 (task t20): what makes two checkouts the same repository across hosts, and which
// commit a remote run starts from. Throwaway: never built.
//
//   node spikes/d2-part-two/repo-probe.mjs
//
// Two clones in a temporary directory stand for the checkouts of one repository on host A and
// host B. Every fact below is git's own behaviour (git 2.43 here); no network and no remote host.
// Writes evidence/repo.ndjson. Commit ids are shortened; paths are not recorded.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidence } from './lib.mjs';

const ev = evidence('repo');
const root = mkdtempSync(join(tmpdir(), 'd2-t20-repo-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (e) {
    return { ok: false, err: String(e.stderr).trim().split('\n').filter(Boolean)[0] ?? `exit ${e.status}` };
  }
};
const short = (sha) => sha.slice(0, 10);
const commit = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
};
const roots = (cwd) => git(cwd, 'rev-list', '--max-parents=0', 'HEAD').split('\n').map(short);

// The upstream every host cloned from, with 30 commits.
const up = join(root, 'upstream');
git(root, 'init', '-q', '-b', 'main', up);
for (let i = 0; i < 30; i++) commit(up, 'f.txt', `line ${i}\n`);
const hostA = join(root, 'host-a');
const hostB = join(root, 'host-b');
git(root, 'clone', '-q', up, hostA);
git(root, 'clone', '-q', `file://${up}`, hostB); // same upstream, written another way

// 1. Identity candidates.
const unrelated = join(root, 'unrelated');
git(root, 'init', '-q', '-b', 'main', unrelated);
commit(unrelated, 'f.txt', 'another project\n');
const fork = join(root, 'fork');
git(root, 'clone', '-q', up, fork);
commit(fork, 'g.txt', 'diverged\n');
const shallow = join(root, 'shallow');
git(root, 'clone', '-q', '--depth', '1', `file://${up}`, shallow);
const local = join(root, 'local-only');
git(root, 'init', '-q', '-b', 'main', local);
commit(local, 'f.txt', 'x\n');
ev.log('identity_root_commit', {
  host_a: roots(hostA),
  host_b: roots(hostB),
  same_on_a_and_b: roots(hostA).join() === roots(hostB).join(),
  unrelated_repo: roots(unrelated),
  fork_with_new_commits: roots(fork),
  fork_shares_root: roots(fork).join() === roots(hostA).join(),
  shallow_clone: roots(shallow),
  shallow_clone_matches: roots(shallow).join() === roots(hostA).join(),
});
ev.log('identity_origin_url', {
  host_a_origin_is_path: !git(hostA, 'remote', 'get-url', 'origin').includes('://'),
  host_b_origin_is_file_url: git(hostB, 'remote', 'get-url', 'origin').startsWith('file://'),
  strings_equal: git(hostA, 'remote', 'get-url', 'origin') === git(hostB, 'remote', 'get-url', 'origin'),
  local_only_repo_has_origin: tryGit(local, 'remote', 'get-url', 'origin').ok,
  note: 'one upstream, two spellings; a repository made locally has no origin at all',
});

// 2. The checkouts differ: A has a commit B does not.
const base = git(hostA, 'rev-parse', 'HEAD');
const a1 = commit(hostA, 'f.txt', 'unpushed work on host A\n');
ev.log('checkouts_differ', {
  caller_head_on_a: short(a1),
  head_on_b: short(git(hostB, 'rev-parse', 'HEAD')),
  b_has_a_commit: tryGit(hostB, 'cat-file', '-e', `${a1}^{commit}`).ok,
  b_has_common_base: tryGit(hostB, 'cat-file', '-e', `${base}^{commit}`).ok,
  note: 'starting from B\'s HEAD would run on code the caller does not have in front of it',
});

// 3. Option: the caller names a commit and B checks it; an exact check, one git call.
const t0 = performance.now();
const check = tryGit(hostB, 'cat-file', '-e', `${base}^{commit}`);
ev.log('option_named_commit', { commit: short(base), present_on_b: check.ok, check_ms: Number((performance.now() - t0).toFixed(1)), missing_commit_error: tryGit(hostB, 'cat-file', '-e', `${a1}^{commit}`).err ?? '(present)' });

// 4. Option: the caller sends the missing commits as a bundle; B verifies it and stores the
//    commit under a run-scoped ref. Needs a base B is known to have.
const thin = join(root, 'thin.bundle');
git(hostA, 'bundle', 'create', '-q', thin, `${base}..HEAD`);
const full = join(root, 'full.bundle');
git(hostA, 'bundle', 'create', '-q', full, 'HEAD');
const verify = tryGit(hostB, 'bundle', 'verify', '-q', thin);
const fetched = tryGit(hostB, 'fetch', '-q', thin, `HEAD:refs/culture-agents/base/probe-run`);
ev.log('option_ship_bundle', {
  thin_bundle_bytes: statSync(thin).size,
  full_bundle_bytes: statSync(full).size,
  verify_on_b: verify.ok,
  fetched_into_run_ref: fetched.ok,
  b_has_a_commit_now: tryGit(hostB, 'cat-file', '-e', `${a1}^{commit}`).ok,
  thin_bundle_verifies_in_repo_without_base: tryGit(unrelated, 'bundle', 'verify', '-q', thin).ok,
});

// 4b. The core moves a run's base into the sandbox as a bundle. A bundle of a bare commit id is
//     refused; a run-scoped ref pointing at the commit works.
const bare = tryGit(hostB, 'bundle', 'create', '-q', join(root, 'bare.bundle'), base);
git(hostB, 'update-ref', 'refs/culture-agents/base/probe-run-2', base);
const viaRef = tryGit(hostB, 'bundle', 'create', '-q', join(root, 'ref.bundle'), 'refs/culture-agents/base/probe-run-2');
ev.log('bundle_of_a_named_commit', { bare_commit_id: bare.ok ? 'created' : bare.err, via_run_scoped_ref: viaRef.ok });

// 5. The real size of a full bundle of this repository's HEAD, the unit the core already moves
//    into each sandbox: what option 4 costs when no common base is known.
const repoTop = git(new URL('.', import.meta.url).pathname, 'rev-parse', '--show-toplevel');
const self = join(root, 'self.bundle');
git(repoTop, 'bundle', 'create', '-q', self, 'HEAD');
ev.log('this_repository_full_bundle', { bytes: statSync(self).size, commits: Number(git(repoTop, 'rev-list', '--count', 'HEAD')) });

ev.log('versions', { git: git(root, 'version') });
rmSync(root, { recursive: true, force: true });
await ev.close();
