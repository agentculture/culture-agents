#!/bin/sh
# Spike shim standing in for pnpm inside the sandbox. The sandbox has no npm
# registry access, so the adapters' bootstrap command
# `pnpm install --frozen-lockfile --store-dir .pnpm-store` cannot run there.
# The bridge dependencies are installed into the image at build time from the
# adapters' own lockfiles; this shim links them into the bootstrap directory.
case "$(basename "$PWD")" in
  claude-code) src=/usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge ;;
  opencode) src=/usr/local/lib/ai-sdk-harness/opencode ;;
  *) echo "pnpm shim: unknown bootstrap dir $PWD" >&2; exit 1 ;;
esac
ln -sfn "$src/node_modules" node_modules
echo "pnpm shim: linked $src/node_modules"
