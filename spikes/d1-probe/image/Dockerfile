# Spike image for the AI SDK harness adapters in OpenShell (plan task t1).
FROM culture-agents-probe:0.2
RUN npm install -g pnpm@10.33.0
# Claude Code bridge deps. The directory sits under
# /usr/lib/node_modules/@anthropic-ai/ because the claude-sub provider profile
# only lets binaries below that glob reach api.anthropic.com, and the Agent SDK
# launches its bundled native `claude` from inside its own node_modules.
COPY cc-bridge/ /usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge/
RUN cd /usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge \
 && pnpm install --frozen-lockfile
# OpenCode bridge deps, under /usr because the sandbox filesystem policy
# makes only /usr, /lib, /etc, /bin readable (not /opt). The lobes profile only lets /usr/local/bin/opencode
# reach the model gateway, so `opencode` on the bridge's PATH points there
# instead of the npm opencode-ai binary the adapter pins.
COPY oc-bridge/ /usr/local/lib/ai-sdk-harness/opencode/
RUN cd /usr/local/lib/ai-sdk-harness/opencode && pnpm install --frozen-lockfile \
 && ln -sfn /usr/local/bin/opencode node_modules/.bin/opencode
RUN npm uninstall -g pnpm
COPY pnpm-shim.sh /usr/local/bin/pnpm
