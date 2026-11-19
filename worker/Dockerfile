FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl \
	&& rm -rf /var/lib/apt/lists/*

# The runner: Agent SDK (bundles its own Claude Code binary) plus our entry script.
WORKDIR /opt/relay
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
COPY container/runner.mjs ./

# Tag must match the installed @cloudflare/sandbox version.
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
