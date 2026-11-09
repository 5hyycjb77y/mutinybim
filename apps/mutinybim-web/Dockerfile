# The MutinyBIM web app. Build from the repository root:
#   docker build -f apps/mutinybim-web/Dockerfile -t mutinybim-web .
FROM node:22-bookworm-slim

# bubblewrap and prlimit: the sealed box each outside assistant's script runs in (src/script-sandbox.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    MUTINYBIM_WEB_HOST=0.0.0.0 \
    MUTINYBIM_WEB_PORT=3100 \
    MUTINYBIM_WEB_DATA=/data \
    NODE_OPTIONS=--max-old-space-size=3072 \
    TSX_TSCONFIG_PATH=apps/mutinybim-web/tsconfig.runtime.json

COPY package.json package-lock.json ./
COPY packages ./packages
COPY public ./public
COPY tools ./tools
COPY apps/mutinybim-web ./apps/mutinybim-web

# The editor is bundled with esbuild and run with tsx, both build-time packages of the workspace.
RUN npm ci --include=dev --no-audit --no-fund

# Build the editor into the image so the first page load doesn't wait for it.
ENV MUTINYBIM_WEB_BUILD=/app/editor-build
RUN node --import tsx apps/mutinybim-web/src/build-editor.ts

# The script runner's two files, root-owned and read-only: the box runs only this copy.
RUN node --import tsx packages/bim-script-runner/src/build.ts /usr/local/lib/mutinybim/script-runner \
  && chown -R root:root /usr/local/lib/mutinybim \
  && chmod 0755 /usr/local/lib/mutinybim /usr/local/lib/mutinybim/script-runner \
  && chmod 0644 /usr/local/lib/mutinybim/script-runner/script-runner.cjs /usr/local/lib/mutinybim/script-runner/script-child.cjs

RUN groupadd --system --gid 10001 mutinybim \
  && useradd --system --uid 10001 --gid 10001 mutinybim \
  && mkdir -p /data && chown mutinybim:mutinybim /data && chown -R mutinybim:mutinybim /app/editor-build

# Starts as root only to give the mounted /data to mutinybim, then runs the app as mutinybim (setpriv).
COPY --chmod=0755 apps/mutinybim-web/docker-entrypoint.sh /usr/local/bin/mutinybim-entrypoint
VOLUME ["/data"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/mutinybim-entrypoint"]
CMD ["node", "--import", "tsx", "apps/mutinybim-web/src/server.ts"]
