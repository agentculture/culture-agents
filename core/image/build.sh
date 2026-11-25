#!/usr/bin/env bash
# Build the run image (default tag culture-agents-run:dev).
#
#   core/image/build.sh [--tag NAME] [--opencode PATH] [--no-claude-compat]
#
# Run `npm ci` in core/ first: the Claude Code bridge manifest and lockfile are
# copied from the installed @ai-sdk/harness-claude-code so the baked bridge
# matches the adapter version core pins. The OpenCode binary comes from
# --opencode, $OPENCODE_BIN or `opencode` on PATH, and must report
# $OPENCODE_VERSION (default 2.3.2, the version the D1 probe measured).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core="$(dirname "$here")"
tag="culture-agents-run:dev"
opencode_bin="${OPENCODE_BIN:-}"
compat=1
want_version="${OPENCODE_VERSION:-2.3.2}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --opencode) opencode_bin="$2"; shift 2 ;;
    --no-claude-compat) compat=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

bridge="$core/node_modules/@ai-sdk/harness-claude-code/dist/bridge"
[ -f "$bridge/package.json" ] || { echo "missing $bridge: run npm ci in core/ first" >&2; exit 2; }

if [ -z "$opencode_bin" ]; then
  opencode_bin="$(command -v opencode || true)"
fi
[ -n "$opencode_bin" ] || { echo "no opencode binary: pass --opencode PATH" >&2; exit 2; }
opencode_bin="$(readlink -f "$opencode_bin")"
got_version="$("$opencode_bin" --version | sed 's/^opencode v//')"
if [ "$got_version" != "$want_version" ]; then
  echo "opencode is $got_version, expected $want_version (set OPENCODE_VERSION to override)" >&2
  exit 2
fi

ctx="$(mktemp -d "${TMPDIR:-/tmp}/culture-agents-image-XXXXXX")"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/claude-code-bridge"
cp "$bridge/package.json" "$ctx/claude-code-bridge/package.json"
# The adapter ships its lockfile as pnpm-lockfile.yaml (pnpm pack drops pnpm-lock.yaml).
cp "$bridge/pnpm-lockfile.yaml" "$ctx/claude-code-bridge/pnpm-lock.yaml"
cp "$bridge/pnpm-workspace.yaml" "$ctx/claude-code-bridge/pnpm-workspace.yaml"
cp "$here/Dockerfile" "$here/pnpm-shim.sh" "$ctx/"
cp "$opencode_bin" "$ctx/opencode"

# Versions as image labels, read by the harness registry's availability check.
claude_version="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.dependencies["@anthropic-ai/claude-code"])' "$bridge/package.json")"
adapter_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$core/node_modules/@ai-sdk/harness-claude-code/package.json")"

docker build --build-arg "CLAUDE_BRIDGE_COMPAT=$compat" \
  --label "dev.culture.agents.claude-code=$claude_version" \
  --label "dev.culture.agents.harness-claude-code=$adapter_version" \
  --label "dev.culture.agents.opencode=$got_version" \
  -t "$tag" "$ctx"
echo "built $tag (opencode $got_version, claude bridge compat=$compat)"
