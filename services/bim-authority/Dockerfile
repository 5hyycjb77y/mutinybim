# MutinyBIM model authority. Build context = repo root (deploy.sh stages only
# what is copied below, because Fly packs the context with the root .dockerignore).
#   services/bim-authority/deploy.sh <fly config>
FROM node:22.23.4-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Installed at /app so the engine packages (copied with the repo layout) resolve zod from here too.
COPY services/bim-authority/package.json services/bim-authority/package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY packages/bim-kernel /app/packages/bim-kernel
COPY packages/bim-sync /app/packages/bim-sync
# The kernel's schedule engine evaluates formulas with typed units at runtime.
COPY packages/bim-units /app/packages/bim-units
COPY packages/bim-formula /app/packages/bim-formula
# The first-party add-ons every model opens with, and what they're built on (the add-on contract, calcs, library, checks).
COPY packages/bim-pack /app/packages/bim-pack
COPY packages/bim-plugin /app/packages/bim-plugin
COPY packages/bim-calc /app/packages/bim-calc
COPY packages/bim-library /app/packages/bim-library
COPY packages/bim-lint /app/packages/bim-lint
COPY packages/bim-first-party /app/packages/bim-first-party
COPY packages/bim-pack-electrical /app/packages/bim-pack-electrical
COPY packages/bim-pack-plumbing /app/packages/bim-pack-plumbing
COPY packages/bim-pack-mechanical /app/packages/bim-pack-mechanical
COPY packages/bim-pack-structural /app/packages/bim-pack-structural
COPY packages/bim-pack-civil /app/packages/bim-pack-civil
COPY packages/bim-pack-architecture /app/packages/bim-pack-architecture
# Linked-model imports (Propose changes to this model) read IFC on this server.
COPY packages/bim-ifc /app/packages/bim-ifc
COPY services/bim-authority/tsconfig.json /app/services/bim-authority/
COPY services/bim-authority/src /app/services/bim-authority/src
# Applied by the deploy's release step (fly.toml release_command → src/migrate.ts).
COPY services/bim-authority/db/migrations /app/services/bim-authority/db/migrations

ARG BIM_AUTHORITY_COMMIT=unknown
ENV BIM_AUTHORITY_COMMIT=${BIM_AUTHORITY_COMMIT}

WORKDIR /app/services/bim-authority
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
