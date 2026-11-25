#!/bin/sh
# Stands in for pnpm inside the run sandbox. The AI SDK Claude Code adapter's
# bootstrap runs `pnpm install --frozen-lockfile --store-dir .pnpm-store` in
# $HOME/.ai-sdk-harness/.harness-bootstrap/claude-code, but the sandbox has no
# npm registry. The bridge dependencies were installed into the image at build
# time from the adapter's own lockfile; this shim links them instead.
#
# It prefers the compatibility copy under /usr/lib/node_modules/@anthropic-ai/
# when the image has one (the running gateway's profile only allows binaries
# there), and otherwise uses /usr/local/lib/ai-sdk-harness/claude-code (the
# location the repo's profile allows).
set -e
case "$(basename "$PWD")" in
  claude-code)
    src=/usr/local/lib/ai-sdk-harness/claude-code
    compat=/usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge
    [ -d "$compat/node_modules" ] && src=$compat
    ;;
  *)
    echo "pnpm shim: no baked dependencies for $PWD" >&2
    exit 1
    ;;
esac
ln -sfn "$src/node_modules" node_modules
echo "pnpm shim: linked $src/node_modules"
