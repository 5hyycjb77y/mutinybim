#!/usr/bin/env bash
# Stage the MutinyBIM authority's Docker build context: exactly what the
# Dockerfile copies, in the repo's layout. Used by deploy.sh and by CI, so the
# image CI builds is the image Fly runs.
#
#   services/bim-authority/stage.sh <empty build dir>
set -euo pipefail

BUILD="${1:?usage: stage.sh <build dir>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "${BUILD}"

copy() { mkdir -p "${BUILD}/$(dirname "$1")"; rsync -a --exclude node_modules --exclude __tests__ --exclude dist "${ROOT}/$1" "${BUILD}/$(dirname "$1")/"; }
copy packages/bim-kernel
copy packages/bim-sync
copy packages/bim-units
copy packages/bim-formula
copy packages/bim-pack
copy packages/bim-plugin
copy packages/bim-calc
copy packages/bim-library
copy packages/bim-lint
copy packages/bim-first-party
copy packages/bim-pack-electrical
copy packages/bim-pack-plumbing
copy packages/bim-pack-mechanical
copy packages/bim-pack-structural
copy packages/bim-pack-civil
copy packages/bim-pack-architecture
copy packages/bim-ifc
mkdir -p "${BUILD}/services/bim-authority"
for f in package.json package-lock.json tsconfig.json; do cp "${ROOT}/services/bim-authority/${f}" "${BUILD}/services/bim-authority/"; done
copy services/bim-authority/src
copy services/bim-authority/db/migrations
cp "${ROOT}/services/bim-authority/Dockerfile" "${BUILD}/Dockerfile"
