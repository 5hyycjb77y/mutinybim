#!/usr/bin/env bash
# Runs one CI step through ci-report.cjs, which puts what failed on the run
# summary and as annotations on the pull request (see its header):
#
#   bash .github/scripts/report.sh --kind <tsc|eslint|jest|gitleaks|lines> --name "<step>" [--json <file>] -- <command> [args...]
#
# A checkout without ci-report.cjs runs the command as it is, so a workflow
# never depends on which of the two landed first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$here/ci-report.cjs" ]; then
  exec node "$here/ci-report.cjs" run "$@"
fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
if [ "$#" -eq 0 ]; then
  echo "::error::report.sh: no command after --" >&2
  exit 2
fi
shift
exec "$@"
