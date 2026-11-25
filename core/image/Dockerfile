# Run image for culture-agents harness drivers (plan task t11), tag
# culture-agents-run:dev. Build it with core/image/build.sh, which stages the
# context: the AI SDK Claude Code bridge manifest and lockfile (copied from the
# installed @ai-sdk/harness-claude-code, so the baked dependencies match the
# adapter version core pins) and the OpenCode v2 binary.
#
# Derived from the D1 probe (docs/d0/probe.md, "What the image must contain"):
# - No USER line: OpenShell refuses a workload identity with UID or GID 0, and
#   an image without USER runs as `ubuntu` (uid 1000) with HOME=/sandbox.
# - The sandbox has no npm registry, so bridge dependencies are installed here
#   and a pnpm shim links them into the adapter's bootstrap directory.
# - Only /usr, /lib, /etc and /bin are readable in the sandbox (not /opt), so
#   everything lives under /usr.
ARG BASE_IMAGE=nvcr.io/nvidia/base/ubuntu:24.04
FROM ${BASE_IMAGE}

ARG NODE_MAJOR=22
ARG PNPM_VERSION=10.33.0

# git and openssh-client for the working-tree handoff (clone from a bundle in,
# the host fetches over SSH out); procps for the process checks after cancel.
# Node.js comes from the NodeSource apt repository, added by hand: its signing
# key is fetched over HTTPS only and the repository is pinned to that key, so
# no downloaded script is executed. curl and gnupg are only needed for that and
# are purged again: the repo's local-gateway profile deliberately does not let
# curl reach the gateway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client procps \
 && mkdir -p /etc/apt/keyrings \
 && curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g --ignore-scripts "pnpm@${PNPM_VERSION}" \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Claude Code bridge dependencies at the location the repo's profile
# (core/policy/profiles/culture-agents-claude-subscription.yaml) allows:
# /usr/local/lib/ai-sdk-harness/**. The Agent SDK launches the native `claude`
# bundled in these node_modules, so this path is what the egress policy sees.
COPY claude-code-bridge/ /usr/local/lib/ai-sdk-harness/claude-code/
WORKDIR /usr/local/lib/ai-sdk-harness/claude-code
RUN pnpm install --frozen-lockfile \
 && ./node_modules/.bin/claude --version
WORKDIR /

# Compatibility copy for the profile the running gateway actually has
# (`claude-code-subscription`, binaries /usr/lib/node_modules/@anthropic-ai/**),
# which does not list /usr/local/lib/ai-sdk-harness/**. A symlink would not do:
# the policy matches the resolved executable path. Build with
# CLAUDE_BRIDGE_COMPAT=0 once the gateway runs the repo's profile.
ARG CLAUDE_BRIDGE_COMPAT=1
RUN if [ "$CLAUDE_BRIDGE_COMPAT" = "1" ]; then \
      mkdir -p /usr/lib/node_modules/@anthropic-ai \
      && cp -a /usr/local/lib/ai-sdk-harness/claude-code \
               /usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge; \
    fi \
 && npm uninstall -g pnpm
COPY pnpm-shim.sh /usr/local/bin/pnpm

# OpenCode v2, driven through its own server API (`opencode serve`). Both the
# repo's local-gateway profile and the gateway's `lobes-gateway` profile let
# exactly /usr/local/bin/opencode reach the model gateway. No AI SDK OpenCode
# bridge is installed: that adapter targets the OpenCode 1.x server API.
COPY opencode /usr/local/bin/opencode
RUN chmod 0755 /usr/local/bin/pnpm /usr/local/bin/opencode && /usr/local/bin/opencode --version

LABEL org.opencontainers.image.title="culture-agents run image" \
      org.opencontainers.image.source="https://github.com/agentculture/culture-agents"
