#!/bin/sh
# Spike shim: the harness-opencode bridge pins @opencode-ai/sdk 1.19.5, whose
# createOpencodeServer waits for the line "opencode server listening on URL".
# OpenCode v2 prints "server listening on URL", so the bridge times out. This
# shim runs the real v2 binary (the path the lobes profile allows) and
# rewrites that one line. Everything else passes through unchanged.
if [ "$1" = "serve" ]; then
  /usr/local/bin/opencode "$@" | sed -u 's/^server listening on/opencode server listening on/'
else
  exec /usr/local/bin/opencode "$@"
fi
